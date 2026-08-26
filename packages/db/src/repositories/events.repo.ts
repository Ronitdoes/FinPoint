import { and, eq, ne, sql } from "drizzle-orm";
import { events, type Event, type NewEvent } from "../schema/events";
import { type RepoContext, getExecutor } from "./types";

export interface InsertEventInput {
  tenantId: string;
  source: NewEvent["source"];
  externalEventId?: string | null;
  type: NewEvent["type"];
  customerId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  rawPayload: Record<string, unknown>;
  payload: Record<string, unknown>;
  correlationId: string;
  status?: NewEvent["status"];
  receivedAt?: Date;
}

export type InsertEventResult =
  | { event: Event; duplicate: false }
  | { event: Event; duplicate: true };

/**
 * Inserts an inbound event idempotently using (source, external_event_id).
 * If a webhook is redelivered, returns the existing record flagged with duplicate: true.
 */
export async function insertEventIfNew(
  ctx: RepoContext,
  input: InsertEventInput,
): Promise<InsertEventResult> {
  const executor = getExecutor(ctx);

  if (input.externalEventId) {
    const inserted = await executor
      .insert(events)
      .values({
        tenantId: input.tenantId,
        source: input.source,
        externalEventId: input.externalEventId,
        type: input.type,
        customerId: input.customerId,
        entityType: input.entityType,
        entityId: input.entityId,
        rawPayload: input.rawPayload,
        payload: input.payload,
        correlationId: input.correlationId,
        status: input.status ?? "RECEIVED",
        receivedAt: input.receivedAt ?? new Date(),
      })
      .onConflictDoNothing({
        target: [events.source, events.externalEventId],
        where: sql`${events.externalEventId} IS NOT NULL`,
      })
      .returning();

    if (inserted.length > 0) {
      return { event: inserted[0], duplicate: false };
    }

    // Duplicate occurred: retrieve existing row
    const [existing] = await executor
      .select()
      .from(events)
      .where(
        and(
          eq(events.source, input.source),
          eq(events.externalEventId, input.externalEventId),
        ),
      )
      .limit(1);

    return { event: existing, duplicate: true };
  }

  // No externalEventId: insert directly
  const [created] = await executor
    .insert(events)
    .values({
      tenantId: input.tenantId,
      source: input.source,
      externalEventId: null,
      type: input.type,
      customerId: input.customerId,
      entityType: input.entityType,
      entityId: input.entityId,
      rawPayload: input.rawPayload,
      payload: input.payload,
      correlationId: input.correlationId,
      status: input.status ?? "RECEIVED",
      receivedAt: input.receivedAt ?? new Date(),
    })
    .returning();

  return { event: created, duplicate: false };
}

export async function findEventById(
  ctx: RepoContext,
  { tenantId, eventId }: { tenantId: string; eventId: string },
): Promise<Event | null> {
  const executor = getExecutor(ctx);
  const [event] = await executor
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)))
    .limit(1);
  return event ?? null;
}

export async function findEventBySourceAndExternalId(
  ctx: RepoContext,
  {
    source,
    externalEventId,
  }: { source: NewEvent["source"]; externalEventId: string },
): Promise<Event | null> {
  const executor = getExecutor(ctx);
  const [event] = await executor
    .select()
    .from(events)
    .where(
      and(
        eq(events.source, source),
        eq(events.externalEventId, externalEventId),
      ),
    )
    .limit(1);
  return event ?? null;
}

export async function markEventProcessed(
  ctx: RepoContext,
  {
    tenantId,
    eventId,
    processedAt = new Date(),
  }: { tenantId: string; eventId: string; processedAt?: Date },
): Promise<Event | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(events)
    .set({
      status: "PROCESSED",
      processedAt,
    })
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)))
    .returning();
  return updated ?? null;
}

export async function markEventFailed(
  ctx: RepoContext,
  { tenantId, eventId }: { tenantId: string; eventId: string },
): Promise<Event | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(events)
    .set({
      status: "FAILED",
    })
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)))
    .returning();
  return updated ?? null;
}

export async function listUnprocessedEvents(
  ctx: RepoContext,
  { tenantId, limit = 50 }: { tenantId?: string; limit?: number } = {},
): Promise<Event[]> {
  const executor = getExecutor(ctx);
  const conditions = [ne(events.status, "PROCESSED")];
  if (tenantId) {
    conditions.push(eq(events.tenantId, tenantId));
  }

  return await executor
    .select()
    .from(events)
    .where(and(...conditions))
    .limit(limit)
    .orderBy(events.receivedAt);
}
