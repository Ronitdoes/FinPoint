import { and, desc, eq } from "drizzle-orm";
import {
  messages,
  messageDeliveryEvents,
  type Message,
  type NewMessage,
  type MessageDeliveryEvent,
  type NewMessageDeliveryEvent,
} from "../schema/messages";
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
  status: NewMessage["status"];
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

export async function updateMessageStatus(
  ctx: RepoContext,
  input: UpdateMessageStatusInput,
): Promise<Message | null> {
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
