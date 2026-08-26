import {
  bigint,
  char,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { customers } from "./customers";
import { providerEnum, subscriptionStatusEnum } from "./enums";
import { timestamps } from "./_shared";

/**
 * Subscriptions table — recurring billing state from Stripe/Razorpay.
 * Anchor for subscription renewal failure recovery workflows.
 */
export const subscriptions = pgTable(
  "subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    planName: text("plan_name"),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    status: subscriptionStatusEnum("status").notNull().default("ACTIVE"),
    provider: providerEnum("provider").notNull(),
    providerSubscriptionId: text("provider_subscription_id").notNull(),
    currentPeriodStart: timestamp("current_period_start", {
      withTimezone: true,
      mode: "date",
    }),
    currentPeriodEnd: timestamp("current_period_end", {
      withTimezone: true,
      mode: "date",
    }),
    cancelledAt: timestamp("cancelled_at", {
      withTimezone: true,
      mode: "date",
    }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("subscriptions_tenant_provider_sub_id_unique").on(
      table.tenantId,
      table.provider,
      table.providerSubscriptionId,
    ),
    index("subscriptions_customer_status_idx").on(
      table.customerId,
      table.status,
    ),
    index("subscriptions_tenant_id_idx").on(table.tenantId),
  ],
);

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
