import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  messages,
  messageDeliveryEvents,
  type Message,
  type NewMessage,
  type MessageDeliveryEvent,
  type NewMessageDeliveryEvent,
} from "../schema/messages";
import type { MessageStatus } from "@repo/domain";
import { type RepoContext, getExecutor } from "./types";
import { DuplicateMessageError, isUniqueViolation } from "./errors";

export interface InsertMessageInput {
  tenantId: string;
  caseId?: string;
  customerId: string;
  channel: NewMessage["channel"];
  direction?: NewMessage["direction"];
  templateId: string;
  variables?: Record<string, unknown>;
  toAddress: string;
  provider: NewMessage["provider"];
  providerMessageId?: string;
  idempotencyKey: string;
  status?: NewMessage["status"];
  sentAt?: Date;
  finalStatusAt?: Date;
}

export interface UpdateMessageStatusInput {
  tenantId: string;
  messageId: string;
  status: MessageStatus;
  providerMessageId?: string;
  sentAt?: Date;
  finalStatusAt?: Date;
}

export interface RecordDeliveryEventInput {
  messageId: string;
  status: NewMessageDeliveryEvent["status"];
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

/**
 * Inserts a customer communication message.
 * Throws DuplicateMessageError if idempotency key conflicts.
 */
export async function insertMessage(
  ctx: RepoContext,
  input: InsertMessageInput,
): Promise<Message> {
  const executor = getExecutor(ctx);

  try {
    const [created] = await executor
      .insert(messages)
      .values({
        tenantId: input.tenantId,
        caseId: input.caseId,
        customerId: input.customerId,
        channel: input.channel,
        direction: input.direction ?? "OUTBOUND",
        templateId: input.templateId,
        variables: input.variables ?? {},
        toAddress: input.toAddress,
        provider: input.provider,
        providerMessageId: input.providerMessageId,
        idempotencyKey: input.idempotencyKey,
        status: input.status ?? "QUEUED",
        sentAt: input.sentAt,
        finalStatusAt: input.finalStatusAt,
      })
      .returning();

    return created;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DuplicateMessageError(
        `Message with idempotency key '${input.idempotencyKey}' already exists`,
      );
    }
    throw error;
  }
}

export async function findMessageById(
  ctx: RepoContext,
  { tenantId, messageId }: { tenantId: string; messageId: string },
): Promise<Message | null> {
  const executor = getExecutor(ctx);
  const [message] = await executor
    .select()
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.id, messageId)))
    .limit(1);
  return message ?? null;
}

export async function findMessageByIdempotencyKey(
  ctx: RepoContext,
  { tenantId, idempotencyKey }: { tenantId: string; idempotencyKey: string },
): Promise<Message | null> {
  const executor = getExecutor(ctx);
  const [message] = await executor
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return message ?? null;
}

/**
 * Allowlisted cross-tenant lookup: inbound provider webhooks arrive keyed only by
 * provider message id (no tenant context yet), so tenant scoping is optional here.
 *
 * @allowCrossTenant - sweeper/admin read (webhook correlation without tenant context;
 *   callers must use the row's tenantId for all subsequent writes)
 */
export async function findMessageByProviderMessageId(
  ctx: RepoContext,
  { tenantId, providerMessageId }: { tenantId?: string; providerMessageId: string },
): Promise<Message | null> {
  const executor = getExecutor(ctx);
  const conditions = [eq(messages.providerMessageId, providerMessageId)];
  if (tenantId) {
    conditions.push(eq(messages.tenantId, tenantId));
  }
  const [message] = await executor
    .select()
    .from(messages)
    .where(and(...conditions))
    .limit(1);
  return message ?? null;
}

/**
 * Legal predecessors for each message status target (CONVENTIONS §9 guarded writes).
 *
 * Forward view:
 * - QUEUED    → SENT, FAILED            (provider accept / synchronous send failure)
 * - SENT      → DELIVERED, READ, FAILED, BOUNCED, REJECTED
 * - DELIVERED → READ, FAILED, BOUNCED, REJECTED
 * - READ / FAILED / BOUNCED / REJECTED → terminal, no outgoing transitions
 *
 * REJECTED (provider policy/template rejections, email drops) mirrors BOUNCED:
 * reachable only once the provider has accepted the message (post-SENT).
 * Terminal sources appear in NO predecessor list, so any write from a terminal
 * row matches zero rows and returns null — the cases.repo.ts race pattern.
 */
export const MESSAGE_LEGAL_PREDECESSORS: Record<MessageStatus, MessageStatus[]> = {
  QUEUED: [],
  SENT: ["QUEUED"],
  DELIVERED: ["SENT"],
  READ: ["SENT", "DELIVERED"],
  FAILED: ["QUEUED", "SENT", "DELIVERED"],
  BOUNCED: ["SENT", "DELIVERED"],
  REJECTED: ["SENT", "DELIVERED"],
};

/**
 * Guarded message status transition (CONVENTIONS §9; s-06 guarded writes).
 *
 * Atomically moves a message to `input.status` only when its current status is a
 * legal predecessor (see MESSAGE_LEGAL_PREDECESSORS). Returns the updated row, or
 * `null` when the row is missing, already terminal, or the transition is illegal
 * (concurrent webhook deliveries racing on the same receipt converge here).
 *
 * Callers treat `null` as "already settled / raced" — delivery receipts are still
 * appended (append-only), so no receipt is lost when the status write is skipped.
 * Webhook handlers pre-check terminal status app-side; this WHERE clause is the
 * DB-level enforcement of the same rule.
 */
export async function updateMessageStatus(
  ctx: RepoContext,
  input: UpdateMessageStatusInput,
): Promise<Message | null> {
  const allowedFrom = MESSAGE_LEGAL_PREDECESSORS[input.status] ?? [];
  if (allowedFrom.length === 0) {
    // No legal predecessor exists for this target (e.g. back to QUEUED):
    // refuse without touching the row.
    return null;
  }

  const executor = getExecutor(ctx);
  const updateData: Partial<NewMessage> = {
    status: input.status,
    updatedAt: new Date(),
  };
  if (input.providerMessageId !== undefined)
    updateData.providerMessageId = input.providerMessageId;
  if (input.sentAt !== undefined) updateData.sentAt = input.sentAt;
  if (input.finalStatusAt !== undefined)
    updateData.finalStatusAt = input.finalStatusAt;

  const [updated] = await executor
    .update(messages)
    .set(updateData)
    .where(
      and(
        eq(messages.tenantId, input.tenantId),
        eq(messages.id, input.messageId),
        inArray(messages.status, allowedFrom),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Appends a delivery status receipt (append-only).
 */
export async function recordDeliveryEvent(
  ctx: RepoContext,
  input: RecordDeliveryEventInput,
): Promise<MessageDeliveryEvent> {
  const executor = getExecutor(ctx);
  const [event] = await executor
    .insert(messageDeliveryEvents)
    .values({
      messageId: input.messageId,
      status: input.status,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();
  return event;
}

/**
 * Lists delivery timeline receipts for a message (append-only reader).
 */
export async function listDeliveryEvents(
  ctx: RepoContext,
  { messageId }: { messageId: string },
): Promise<MessageDeliveryEvent[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(messageDeliveryEvents)
    .where(eq(messageDeliveryEvents.messageId, messageId))
    .orderBy(messageDeliveryEvents.occurredAt);
}

export async function listMessagesForCase(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<Message[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.caseId, caseId)))
    .orderBy(desc(messages.createdAt));
}

export async function listMessagesForCustomer(
  ctx: RepoContext,
  {
    tenantId,
    customerId,
    limit = 50,
    offset = 0,
  }: { tenantId: string; customerId: string; limit?: number; offset?: number },
): Promise<Message[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(messages)
    .where(and(eq(messages.tenantId, tenantId), eq(messages.customerId, customerId)))
    .orderBy(desc(messages.sentAt), desc(messages.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function listMessages(
  ctx: RepoContext,
  {
    tenantId,
    caseId,
    customerId,
    channel,
    status,
    limit = 50,
    offset = 0,
  }: {
    tenantId: string;
    caseId?: string;
    customerId?: string;
    channel?: NewMessage["channel"];
    status?: NewMessage["status"];
    limit?: number;
    offset?: number;
  },
): Promise<Message[]> {
  const executor = getExecutor(ctx);
  const conditions = [eq(messages.tenantId, tenantId)];

  if (caseId) {
    conditions.push(eq(messages.caseId, caseId));
  }
  if (customerId) {
    conditions.push(eq(messages.customerId, customerId));
  }
  if (channel) {
    conditions.push(eq(messages.channel, channel));
  }
  if (status) {
    conditions.push(eq(messages.status, status));
  }

  return await executor
    .select()
    .from(messages)
    .where(and(...conditions))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function countCustomerMessagesByChannelSince(
  ctx: RepoContext,
  {
    tenantId,
    customerId,
    channel,
    since,
  }: {
    tenantId: string;
    customerId: string;
    channel: NewMessage["channel"];
    since: Date;
  },
): Promise<number> {
  const executor = getExecutor(ctx);
  const conditions = [
    eq(messages.tenantId, tenantId),
    eq(messages.customerId, customerId),
    eq(messages.channel, channel),
    or(gte(messages.sentAt, since), gte(messages.createdAt, since)),
  ];

  const [row] = await executor
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(...conditions));

  return Number(row?.count ?? 0);
}

