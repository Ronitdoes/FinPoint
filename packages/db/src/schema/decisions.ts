import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenants } from "./tenants";
import { recoveryCases } from "./cases";
import { decisionStatusEnum } from "./enums";

/**
 * AI Decisions table — complete evaluation dataset for LLM decisions (Spec 01 §5, Spec 02 §3).
 * Captures redacted input snapshots, raw structured outputs, token counts, and diagnosis confidence.
 */
export const aiDecisions = pgTable(
  "ai_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => recoveryCases.id, { onDelete: "restrict" }),
    model: text("model").notNull(),
    modelVersion: text("model_version"),
    promptVersion: text("prompt_version").notNull(),
    inputSnapshot: jsonb("input_snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    outputRaw: jsonb("output_raw").$type<Record<string, unknown>>(),
    diagnosisCause: text("diagnosis_cause"),
    diagnosisConfidence: numeric("diagnosis_confidence", {
      precision: 3,
      scale: 2,
    }),
    recommendedActions: jsonb("recommended_actions")
      .$type<unknown[]>()
      .notNull(),
    stopConditions: text("stop_conditions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    status: decisionStatusEnum("status").notNull(),
    latencyMs: integer("latency_ms"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costMinorUnits: bigint("cost_minor_units", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    error: text("error"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "ai_decisions_confidence_check",
      sql`${table.diagnosisConfidence} IS NULL OR (${table.diagnosisConfidence} >= 0 AND ${table.diagnosisConfidence} <= 1)`,
    ),
    index("ai_decisions_case_created_at_idx").on(
      table.caseId,
      table.createdAt.desc(),
    ),
    index("ai_decisions_tenant_id_idx").on(table.tenantId),
  ],
);

export type AiDecision = typeof aiDecisions.$inferSelect;
export type NewAiDecision = typeof aiDecisions.$inferInsert;
