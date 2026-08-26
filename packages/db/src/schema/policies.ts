import {
  boolean,
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
import { users } from "./users";
import { recoveryCases } from "./cases";
import { aiDecisions } from "./decisions";
import {
  policyResultEnum,
  policyRuleKindEnum,
} from "./enums";
import { timestamps } from "./_shared";

/**
 * Policy Rules table — deterministic safety and financial rules (Spec 01 §5, Spec 02 §7).
 * Null tenant_id indicates platform-wide default rules.
 */
export const policyRules = pgTable(
  "policy_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "restrict",
    }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    ruleKind: policyRuleKindEnum("rule_kind").notNull(),
    definition: jsonb("definition")
      .$type<Record<string, unknown>>()
      .notNull(),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("policy_rules_code_unique").on(table.code),
    index("policy_rules_tenant_id_idx").on(table.tenantId),
  ],
);

export type PolicyRule = typeof policyRules.$inferSelect;
export type NewPolicyRule = typeof policyRules.$inferInsert;

/**
 * Policy Versions table — immutable audit snapshots of policy rule definitions (Spec 01 §5).
 */
export const policyVersions = pgTable(
  "policy_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => policyRules.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("policy_versions_rule_version_unique").on(
      table.ruleId,
      table.version,
    ),
    index("policy_versions_rule_id_idx").on(table.ruleId),
  ],
);

export type PolicyVersion = typeof policyVersions.$inferSelect;
export type NewPolicyVersion = typeof policyVersions.$inferInsert;

/**
 * Policy Evaluations table — append-only audit trail for every policy evaluation (Spec 01 §5, §18).
 */
export const policyEvaluations = pgTable(
  "policy_evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id").references(() => recoveryCases.id, {
      onDelete: "set null",
    }),
    decisionId: uuid("decision_id").references(() => aiDecisions.id, {
      onDelete: "set null",
    }),
    ruleVersions: uuid("rule_versions").array().notNull(),
    result: policyResultEnum("result").notNull(),
    rejections: jsonb("rejections")
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    effectiveActions: jsonb("effective_actions")
      .$type<unknown[]>()
      .notNull(),
    latencyMs: integer("latency_ms").notNull(),
    evaluatedAt: timestamp("evaluated_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("policy_evaluations_tenant_id_idx").on(table.tenantId),
    index("policy_evaluations_case_id_idx").on(table.caseId),
  ],
);

export type PolicyEvaluation = typeof policyEvaluations.$inferSelect;
export type NewPolicyEvaluation = typeof policyEvaluations.$inferInsert;
