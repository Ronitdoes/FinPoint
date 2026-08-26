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
import { invoiceStatusEnum, providerEnum } from "./enums";
import { timestamps } from "./_shared";

/**
 * Invoices table — B2B/recurring invoice records (Workflow C).
 * Tracks due dates, overdue escalation, and promise-to-pay arrangements.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    number: text("number").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    amountPaid: bigint("amount_paid", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    currency: char("currency", { length: 3 }).notNull(),
    status: invoiceStatusEnum("status").notNull().default("DRAFT"),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }),
    dueAt: timestamp("due_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    disputedAt: timestamp("disputed_at", {
      withTimezone: true,
      mode: "date",
    }),
    provider: providerEnum("provider"),
    providerInvoiceId: text("provider_invoice_id"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("invoices_tenant_number_unique").on(
      table.tenantId,
      table.number,
    ),
    uniqueIndex("invoices_tenant_provider_invoice_id_unique")
      .on(table.tenantId, table.provider, table.providerInvoiceId)
      .where(sql`provider_invoice_id IS NOT NULL`),
    index("invoices_status_due_at_idx").on(table.status, table.dueAt),
    index("invoices_tenant_customer_status_idx").on(
      table.tenantId,
      table.customerId,
      table.status,
    ),
    index("invoices_tenant_id_idx").on(table.tenantId),
  ],
);

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;

/**
 * Invoice Events table — append-only chronological ledger of invoice actions.
 * Monotonically ordered via BIGSERIAL id (ADR-010).
 */
export const invoiceEvents = pgTable(
  "invoice_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
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
    index("invoice_events_invoice_occurred_at_idx").on(
      table.invoiceId,
      table.occurredAt,
    ),
  ],
);

export type InvoiceEvent = typeof invoiceEvents.$inferSelect;
export type NewInvoiceEvent = typeof invoiceEvents.$inferInsert;
