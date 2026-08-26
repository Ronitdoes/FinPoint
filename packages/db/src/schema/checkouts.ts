import {
  bigint,
  bigserial,
  char,
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
import { checkoutStatusEnum } from "./enums";
import { timestamps, type CheckoutItem } from "./_shared";

/**
 * Checkouts table — shopping cart and checkout session state (Workflow B).
 * Used for checkout abandonment detection, timing, and recovery interventions.
 */
export const checkouts = pgTable(
  "checkouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    cartValue: bigint("cart_value", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    currency: char("currency", { length: 3 }).notNull(),
    items: jsonb("items").$type<CheckoutItem[]>().notNull().default([]),
    status: checkoutStatusEnum("status").notNull().default("STARTED"),
    sourceRef: text("source_ref"),
    startedAt: timestamp("started_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    lastActivityAt: timestamp("last_activity_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    completedAt: timestamp("completed_at", {
      withTimezone: true,
      mode: "date",
    }),
    abandonedAt: timestamp("abandoned_at", {
      withTimezone: true,
      mode: "date",
    }),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "date",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("checkouts_tenant_source_ref_unique")
      .on(table.tenantId, table.sourceRef)
      .where(sql`source_ref IS NOT NULL`),
    index("checkouts_status_last_activity_idx").on(
      table.status,
      table.lastActivityAt,
    ),
    index("checkouts_tenant_customer_status_idx").on(
      table.tenantId,
      table.customerId,
      table.status,
    ),
    index("checkouts_tenant_id_idx").on(table.tenantId),
  ],
);

export type Checkout = typeof checkouts.$inferSelect;
export type NewCheckout = typeof checkouts.$inferInsert;

/**
 * Checkout Events table — append-only chronological ledger of cart actions.
 * Monotonically ordered via BIGSERIAL id (ADR-010).
 */
export const checkoutEvents = pgTable(
  "checkout_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    checkoutId: uuid("checkout_id")
      .notNull()
      .references(() => checkouts.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", {
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
    index("checkout_events_checkout_occurred_at_idx").on(
      table.checkoutId,
      table.occurredAt,
    ),
  ],
);

export type CheckoutEvent = typeof checkoutEvents.$inferSelect;
export type NewCheckoutEvent = typeof checkoutEvents.$inferInsert;
