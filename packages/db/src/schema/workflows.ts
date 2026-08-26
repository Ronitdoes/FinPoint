import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { recoveryCases } from "./cases";
import { workflowStatusEnum } from "./enums";
import { timestamps } from "./_shared";

/**
 * Workflows table — tracks Temporal workflow execution per case (Spec 01 §5, Spec 02 §3).
 * Exactly one workflow record per recovery case lifecycle.
 */
export const workflows = pgTable(
  "workflows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => recoveryCases.id, { onDelete: "restrict" }),
    temporalWorkflowId: text("temporal_workflow_id").notNull(),
    runId: text("run_id"),
    type: text("type").notNull(),
    status: workflowStatusEnum("status").notNull().default("RUNNING"),
    startedAt: timestamp("started_at", {
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
    uniqueIndex("workflows_case_id_unique").on(table.caseId),
    uniqueIndex("workflows_temporal_workflow_id_unique").on(
      table.temporalWorkflowId,
    ),
    index("workflows_tenant_id_idx").on(table.tenantId),
  ],
);

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;

/**
 * Workflow Events table — append-only mirror of significant workflow steps for querying (Spec 01 §5).
 */
export const workflowEvents = pgTable(
  "workflow_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    workflowRowId: uuid("workflow_row_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
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
    index("workflow_events_workflow_occurred_at_idx").on(
      table.workflowRowId,
      table.occurredAt,
    ),
  ],
);

export type WorkflowEvent = typeof workflowEvents.$inferSelect;
export type NewWorkflowEvent = typeof workflowEvents.$inferInsert;
