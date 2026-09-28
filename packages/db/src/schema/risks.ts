import {
  check,
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
import { customers } from "./customers";
import {
  riskBandEnum,
  riskStatusEnum,
  riskTypeEnum,
} from "./enums";
import { timestamps } from "./_shared";

/**
 * Revenue Risks table — rule-based financial risk evaluations (Spec 01 §5, Spec 02 §5).
 * Feeds explainability UI ("why at risk") via factor breakdown.
 */
export const revenueRisks = pgTable(
  "revenue_risks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    riskType: riskTypeEnum("risk_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: uuid("subject_id").notNull(),
    score: integer("score").notNull(),
    band: riskBandEnum("band").notNull(),
    factors: jsonb("factors")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: riskStatusEnum("status").notNull().default("OPEN"),
    computedAt: timestamp("computed_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    ...timestamps,
  },
  (table) => [
    check(
      "revenue_risks_score_check",
      sql`${table.score} >= 0 AND ${table.score} <= 100`,
    ),
    // Anti-duplication (s-12 fix): exactly one OPEN risk per subject.
    // Closes the SELECT-then-INSERT race under concurrent redelivery.
    uniqueIndex("revenue_risks_tenant_subject_open_unique")
      .on(table.tenantId, table.subjectType, table.subjectId)
      .where(sql`${table.status} = 'OPEN'`),
    index("revenue_risks_status_score_idx").on(
      table.status,
      table.score.desc(),
    ),
    index("revenue_risks_tenant_subject_idx").on(
      table.tenantId,
      table.subjectType,
      table.subjectId,
    ),
    index("revenue_risks_tenant_id_idx").on(table.tenantId),
    index("revenue_risks_customer_id_idx").on(table.customerId),
  ],
);

export type RevenueRisk = typeof revenueRisks.$inferSelect;
export type NewRevenueRisk = typeof revenueRisks.$inferInsert;
