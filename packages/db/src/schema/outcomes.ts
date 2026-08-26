import {
  bigint,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { recoveryCases } from "./cases";
import { payments } from "./payments";
import { recoveryCostCategoryEnum } from "./enums";
import { timestamps } from "./_shared";

/**
 * Recovery Outcomes table — authoritative financial outcome per case (Spec 01 §5, §25, Spec 02 §9).
 * Exactly one final outcome row per case (unique case_id anchor).
 * Net recovered is computed at database layer via generated always column.
 */
export const recoveryOutcomes = pgTable(
  "recovery_outcomes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => recoveryCases.id, { onDelete: "restrict" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    baselineAmount: bigint("baseline_amount", { mode: "bigint" }).notNull(),
    recoveredAmount: bigint("recovered_amount", { mode: "bigint" }).notNull(),
    recoveryCost: bigint("recovery_cost", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    netRecovered: bigint("net_recovered", { mode: "bigint" })
      .generatedAlwaysAs(sql`"recovered_amount" - "recovery_cost"`),
    attributionMethod: text("attribution_method").notNull(),
    attributionWindowHours: integer("attribution_window_hours").notNull(),
    recoveredAt: timestamp("recovered_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    recordedAt: timestamp("recorded_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    // Anti-duplication anchor #5: exactly one recovery outcome recorded per case
    uniqueIndex("recovery_outcomes_case_id_unique").on(table.caseId),
    index("recovery_outcomes_tenant_id_idx").on(table.tenantId),
    index("recovery_outcomes_payment_id_idx").on(table.paymentId),
  ],
);

export type RecoveryOutcome = typeof recoveryOutcomes.$inferSelect;
export type NewRecoveryOutcome = typeof recoveryOutcomes.$inferInsert;

/**
 * Recovery Cost Entries table — append-only ledger tracking all costs per case (Spec 01 §5, Spec 02 §8).
 */
export const recoveryCostEntries = pgTable(
  "recovery_cost_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => recoveryCases.id, { onDelete: "restrict" }),
    category: recoveryCostCategoryEnum("category").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    incurredAt: timestamp("incurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("recovery_cost_entries_case_category_idx").on(
      table.caseId,
      table.category,
    ),
    index("recovery_cost_entries_tenant_id_idx").on(table.tenantId),
  ],
);

export type RecoveryCostEntry = typeof recoveryCostEntries.$inferSelect;
export type NewRecoveryCostEntry = typeof recoveryCostEntries.$inferInsert;
