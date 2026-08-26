import {
  bigint,
  char,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { customers } from "./customers";
import { users } from "./users";
import { revenueRisks } from "./risks";
import {
  caseStatusEnum,
  riskTypeEnum,
} from "./enums";
import { timestamps } from "./_shared";

/**
 * Recovery Cases table — canonical recovery case state (Spec 01 §5, Spec 02 §3).
 * Central object in recovery domain. Partial unique index prevents multiple concurrent live cases for one obligation.
 */
export const recoveryCases = pgTable(
  "recovery_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseNumber: integer("case_number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    riskId: uuid("risk_id").references(() => revenueRisks.id, {
      onDelete: "set null",
    }),
    riskType: riskTypeEnum("risk_type").notNull(),
    sourceEntityType: text("source_entity_type").notNull(),
    sourceEntityId: uuid("source_entity_id").notNull(),
    amountAtRisk: bigint("amount_at_risk", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    riskScore: integer("risk_score").notNull(),
    status: caseStatusEnum("status").notNull().default("DETECTED"),
    statusReason: text("status_reason"),
    stopConditions: text("stop_conditions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    assignedTo: uuid("assigned_to").references(() => users.id, {
      onDelete: "set null",
    }),
    workflowId: uuid("workflow_id"),
    attributionWindowHours: integer("attribution_window_hours")
      .notNull()
      .default(72),
    openedAt: timestamp("opened_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    closedAt: timestamp("closed_at", {
      withTimezone: true,
      mode: "date",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("recovery_cases_tenant_case_number_unique").on(
      table.tenantId,
      table.caseNumber,
    ),
    check(
      "recovery_cases_amount_at_risk_check",
      sql`${table.amountAtRisk} > 0`,
    ),
    // Anti-duplication anchor #2: exactly one live recovery case per obligation
    uniqueIndex("recovery_cases_tenant_source_entity_live_unique")
      .on(table.tenantId, table.sourceEntityType, table.sourceEntityId)
      .where(sql`${table.status} NOT IN ('RECOVERED', 'STOPPED', 'FAILED')`),
    index("recovery_cases_status_opened_at_idx").on(
      table.status,
      table.openedAt,
    ),
    index("recovery_cases_customer_id_idx").on(table.customerId),
    index("recovery_cases_tenant_status_idx").on(
      table.tenantId,
      table.status,
    ),
    index("recovery_cases_tenant_id_idx").on(table.tenantId),
  ],
);

export type RecoveryCase = typeof recoveryCases.$inferSelect;
export type NewRecoveryCase = typeof recoveryCases.$inferInsert;
