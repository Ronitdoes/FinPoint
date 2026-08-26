import {
  bigint,
  char,
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
import { subscriptions } from "./subscriptions";
import {
  paymentAttemptInitiatedByEnum,
  paymentAttemptStatusEnum,
  paymentStatusEnum,
  providerEnum,
} from "./enums";
import { timestamps } from "./_shared";

/**
 * Payments table — canonical payment records (Spec 01 §5, Spec 02 §1).
 * Immutable financial history. Webhook deduplication anchor on (tenant_id, provider, provider_payment_id).
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
      onDelete: "restrict",
    }),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    status: paymentStatusEnum("status").notNull().default("CREATED"),
    provider: providerEnum("provider").notNull(),
    providerPaymentId: text("provider_payment_id").notNull(),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    methodMetadata: jsonb("method_metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "date" }),
    refundedAt: timestamp("refunded_at", {
      withTimezone: true,
      mode: "date",
    }),
    disputedAt: timestamp("disputed_at", {
      withTimezone: true,
      mode: "date",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("payments_tenant_provider_payment_id_unique").on(
      table.tenantId,
      table.provider,
      table.providerPaymentId,
    ),
    check("payments_amount_positive_check", sql`${table.amount} > 0`),
    index("payments_customer_created_at_idx").on(
      table.customerId,
      table.createdAt,
    ),
    index("payments_status_created_at_idx").on(table.status, table.createdAt),
    index("payments_tenant_occurred_at_idx").on(
      table.tenantId,
      table.occurredAt,
    ),
    index("payments_tenant_id_idx").on(table.tenantId),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;

/**
 * Payment Attempts table — individual gateway retry/charge attempts.
 * Protected against duplicate execution via unique idempotency_key and (payment_id, attempt_number).
 */
export const paymentAttempts = pgTable(
  "payment_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => payments.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    initiatedBy: paymentAttemptInitiatedByEnum("initiated_by").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: paymentAttemptStatusEnum("status").notNull(),
    providerReference: text("provider_reference"),
    failureCode: text("failure_code"),
    error: jsonb("error").$type<Record<string, unknown>>(),
    requestedAt: timestamp("requested_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    resolvedAt: timestamp("resolved_at", {
      withTimezone: true,
      mode: "date",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("payment_attempts_payment_attempt_number_unique").on(
      table.paymentId,
      table.attemptNumber,
    ),
    index("payment_attempts_tenant_id_idx").on(table.tenantId),
  ],
);

export type PaymentAttempt = typeof paymentAttempts.$inferSelect;
export type NewPaymentAttempt = typeof paymentAttempts.$inferInsert;
