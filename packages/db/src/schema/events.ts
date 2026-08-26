import {
  index,
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
  eventSourceEnum,
  eventStatusEnum,
  eventTypeEnum,
} from "./enums";

/**
 * Events table — normalized internal event log preserving raw provider payloads (Spec 01 §5, §6).
 * Serves as the webhook deduplication anchor on (source, external_event_id).
 */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: eventSourceEnum("source").notNull(),
    externalEventId: text("external_event_id"),
    type: eventTypeEnum("type").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id").references(() => customers.id, {
      onDelete: "restrict",
    }),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    rawPayload: jsonb("raw_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    correlationId: uuid("correlation_id").notNull(),
    status: eventStatusEnum("status").notNull().default("RECEIVED"),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    processedAt: timestamp("processed_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (table) => [
    uniqueIndex("events_source_external_event_id_unique")
      .on(table.source, table.externalEventId)
      .where(sql`${table.externalEventId} IS NOT NULL`),
    index("events_tenant_type_received_at_idx").on(
      table.tenantId,
      table.type,
      table.receivedAt.desc(),
    ),
    index("events_status_unprocessed_idx")
      .on(table.status)
      .where(sql`${table.status} != 'PROCESSED'`),
    index("events_tenant_id_idx").on(table.tenantId),
    index("events_customer_id_idx").on(table.customerId),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
