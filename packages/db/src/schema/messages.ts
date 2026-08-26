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
import { customers } from "./customers";
import { recoveryCases } from "./cases";
import {
  channelEnum,
  customerResponseTypeEnum,
  messageDirectionEnum,
  messageStatusEnum,
  messagingProviderEnum,
} from "./enums";
import { timestamps } from "./_shared";

/**
 * Messages table — customer communication ledger across channels (Spec 01 §5, Spec 02 §3).
 * Idempotency key format `{tenant}:{case}:{channel}:{template}:{step}` prevents duplicate messages.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    caseId: uuid("case_id").references(() => recoveryCases.id, {
      onDelete: "set null",
    }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    channel: channelEnum("channel").notNull(),
    direction: messageDirectionEnum("direction").notNull().default("OUTBOUND"),
    templateId: text("template_id").notNull(),
    variables: jsonb("variables")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    toAddress: text("to_address").notNull(),
    provider: messagingProviderEnum("provider").notNull(),
    providerMessageId: text("provider_message_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: messageStatusEnum("status").notNull().default("QUEUED"),
    sentAt: timestamp("sent_at", {
      withTimezone: true,
      mode: "date",
    }),
    finalStatusAt: timestamp("final_status_at", {
      withTimezone: true,
      mode: "date",
    }),
    ...timestamps,
  },
  (table) => [
    // Anti-duplication anchor #4: no duplicate customer contact
    uniqueIndex("messages_idempotency_key_unique").on(table.idempotencyKey),
    index("messages_case_created_at_idx").on(
      table.caseId,
      table.createdAt,
    ),
    index("messages_customer_channel_sent_at_idx").on(
      table.customerId,
      table.channel,
      table.sentAt.desc(),
    ),
    index("messages_tenant_id_idx").on(table.tenantId),
  ],
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

/**
 * Message Delivery Events table — append-only delivery/read receipts (Spec 01 §5).
 */
export const messageDeliveryEvents = pgTable(
  "message_delivery_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    status: messageStatusEnum("status").notNull(),
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
    index("message_delivery_events_message_occurred_at_idx").on(
      table.messageId,
      table.occurredAt,
    ),
  ],
);

export type MessageDeliveryEvent = typeof messageDeliveryEvents.$inferSelect;
export type NewMessageDeliveryEvent = typeof messageDeliveryEvents.$inferInsert;

/**
 * Customer Responses table — inbound replies, opt-outs, complaints, and promises (Spec 01 §5).
 */
export const customerResponses = pgTable(
  "customer_responses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    caseId: uuid("case_id").references(() => recoveryCases.id, {
      onDelete: "set null",
    }),
    channel: channelEnum("channel"),
    type: customerResponseTypeEnum("type").notNull(),
    contentRedacted: text("content_redacted"),
    rawRef: text("raw_ref"),
    receivedAt: timestamp("received_at", {
      withTimezone: true,
      mode: "date",
    })
      .defaultNow()
      .notNull(),
    ...timestamps,
  },
  (table) => [
    index("customer_responses_customer_received_at_idx").on(
      table.customerId,
      table.receivedAt.desc(),
    ),
    index("customer_responses_case_id_idx").on(table.caseId),
    index("customer_responses_tenant_id_idx").on(table.tenantId),
  ],
);

export type CustomerResponse = typeof customerResponses.$inferSelect;
export type NewCustomerResponse = typeof customerResponses.$inferInsert;
