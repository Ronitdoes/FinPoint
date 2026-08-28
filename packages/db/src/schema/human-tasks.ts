import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";
import { recoveryCases } from "./cases";
import {
  humanTaskPriorityEnum,
  humanTaskStatusEnum,
  humanTaskTypeEnum,
} from "./enums";
import { timestamps } from "./_shared";

/**
 * Human Tasks table — human-in-the-loop escalation and approvals (Spec 01 §19, Spec 02 §3).
 * Links approvals back to Temporal workflow signals via temporal_signal_sent.
 */
export const humanTasks = pgTable(
  "human_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id")
      .notNull()
      .references(() => recoveryCases.id, { onDelete: "restrict" }),
    type: humanTaskTypeEnum("type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    priority: humanTaskPriorityEnum("priority").notNull().default("MEDIUM"),
    status: humanTaskStatusEnum("status").notNull().default("PENDING"),
    assignedTo: uuid("assigned_to").references(() => users.id, {
      onDelete: "set null",
    }),
    slaDueAt: timestamp("sla_due_at", {
      withTimezone: true,
      mode: "date",
    }),
    overdueAt: timestamp("overdue_at", {
      withTimezone: true,
      mode: "date",
    }),
    escalationCount: integer("escalation_count").notNull().default(0),
    decidedBy: uuid("decided_by").references(() => users.id, {
      onDelete: "set null",
    }),
    decisionNotes: text("decision_notes"),
    decidedAt: timestamp("decided_at", {
      withTimezone: true,
      mode: "date",
    }),
    temporalSignalSent: boolean("temporal_signal_sent")
      .notNull()
      .default(false),
    ...timestamps,
  },
  (table) => [
    index("human_tasks_status_sla_due_at_idx").on(
      table.status,
      table.slaDueAt,
    ),
    index("human_tasks_case_id_idx").on(table.caseId),
    index("human_tasks_tenant_id_idx").on(table.tenantId),
  ],
);

export type HumanTask = typeof humanTasks.$inferSelect;
export type NewHumanTask = typeof humanTasks.$inferInsert;
