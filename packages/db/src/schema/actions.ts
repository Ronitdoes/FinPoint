import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { recoveryCases } from "./cases";
import { aiDecisions } from "./decisions";
import {
  actionStatusEnum,
  actionTypeEnum,
} from "./enums";
import { timestamps } from "./_shared";

/**
 * Recovery Actions table — lifecycle of recovery actions and interventions (Spec 01 §5, Spec 02 §6).
 * Idempotency key format `{tenant}:{case}:{TYPE}:{attempt_number}` prevents double execution.
 */
export const recoveryActions = pgTable(
  "recovery_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => recoveryCases.id, { onDelete: "restrict" }),
    decisionId: uuid("decision_id").references(() => aiDecisions.id, {
      onDelete: "set null",
    }),
    type: actionTypeEnum("type").notNull(),
    parameters: jsonb("parameters")
      .$type<Record<string, unknown>>()
      .notNull(),
    status: actionStatusEnum("status").notNull().default("PROPOSED"),
    policyResult: jsonb("policy_result").$type<Record<string, unknown>>(),
    attemptNumber: integer("attempt_number").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    scheduledAt: timestamp("scheduled_at", {
      withTimezone: true,
      mode: "date",
    }),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<Record<string, unknown>>(),
    ...timestamps,
  },
  (table) => [
    // Anti-duplication anchor #3: no double financial action execution
    uniqueIndex("recovery_actions_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    index("recovery_actions_case_created_at_idx").on(
      table.caseId,
      table.createdAt,
    ),
    index("recovery_actions_tenant_id_idx").on(table.tenantId),
  ],
);

export type RecoveryAction = typeof recoveryActions.$inferSelect;
export type NewRecoveryAction = typeof recoveryActions.$inferInsert;
