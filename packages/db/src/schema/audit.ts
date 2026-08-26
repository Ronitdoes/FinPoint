import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { recoveryCases } from "./cases";
import { actorTypeEnum } from "./enums";

/**
 * Audit Logs table — append-only compliance and audit log (Spec 01 §5, §18).
 * Tracks model versions, prompt versions, decisions, policy checks, and outcomes.
 * No updated_at column by design.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id").references(() => recoveryCases.id, {
      onDelete: "set null",
    }),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    event: text("event").notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    correlationId: uuid("correlation_id"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_logs_case_created_at_idx").on(
      table.caseId,
      table.createdAt,
    ),
    index("audit_logs_tenant_created_at_idx").on(
      table.tenantId,
      table.createdAt.desc(),
    ),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

/**
 * Case Events table — append-only timeline feed powering dashboard views (Spec 01 §5, §17).
 */
export const caseEvents = pgTable(
  "case_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => recoveryCases.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorType: actorTypeEnum("actor_type").notNull(),
    actorId: text("actor_id"),
    description: text("description"),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("case_events_case_occurred_at_idx").on(
      table.caseId,
      table.occurredAt,
    ),
    index("case_events_tenant_id_idx").on(table.tenantId),
  ],
);

export type CaseEvent = typeof caseEvents.$inferSelect;
export type NewCaseEvent = typeof caseEvents.$inferInsert;
