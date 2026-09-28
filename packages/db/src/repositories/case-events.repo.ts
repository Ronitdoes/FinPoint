import { and, asc, desc, eq, gte, inArray, lte, lt, gt, or } from "drizzle-orm";
import {
  caseEvents,
  type CaseEvent,
  type NewCaseEvent,
} from "../schema/audit";
import { type RepoContext, getExecutor } from "./types";
import { sanitizePii } from "./pii-redact";

export interface RecordCaseEventInput {
  tenantId: string;
  caseId: string;
  eventType: string;
  actorType: NewCaseEvent["actorType"];
  actorId?: string;
  description?: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

export interface ListCaseEventsQuery {
  tenantId: string;
  caseId: string;
  types?: string[];
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
}

export interface ListCaseEventsResult {
  items: CaseEvent[];
  nextCursor: string | null;
}

/**
 * Appends a case timeline event (strictly append-only — no update or delete operations).
 *
 * Write-path PII redaction (s-25 MED fix, CONVENTIONS §7/§12): `payload` and
 * `description` are passed through `sanitizePii` before insert so the stored
 * row never holds raw emails, phone numbers, card PANs, or secret tokens.
 */
export async function recordCaseEvent(
  ctx: RepoContext,
  input: RecordCaseEventInput,
): Promise<CaseEvent> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(caseEvents)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      eventType: input.eventType,
      actorType: input.actorType,
      actorId: input.actorId,
      description:
        input.description === undefined
          ? undefined
          : sanitizePii(input.description),
      payload: sanitizePii(input.payload ?? {}),
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();
  return created;
}

export async function findCaseEventById(
  ctx: RepoContext,
  { tenantId, id }: { tenantId: string; id: number },
): Promise<CaseEvent | null> {
  const executor = getExecutor(ctx);
  const [event] = await executor
    .select()
    .from(caseEvents)
    .where(and(eq(caseEvents.tenantId, tenantId), eq(caseEvents.id, id)))
    .limit(1);
  return event ?? null;
}

export async function listCaseEvents(
  ctx: RepoContext,
  {
    tenantId,
    caseId,
    limit = 100,
    offset = 0,
  }: { tenantId: string; caseId: string; limit?: number; offset?: number },
): Promise<CaseEvent[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(caseEvents)
    .where(
      and(eq(caseEvents.tenantId, tenantId), eq(caseEvents.caseId, caseId)),
    )
    .orderBy(asc(caseEvents.occurredAt), asc(caseEvents.id))
    .limit(limit)
    .offset(offset);
}

/**
 * Lists case timeline events with filtering and cursor pagination.
 */
export async function listCaseEventsWithCursor(
  ctx: RepoContext,
  query: ListCaseEventsQuery,
): Promise<ListCaseEventsResult> {
  const executor = getExecutor(ctx);
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 100);
  const isDesc = query.order === "desc";

  const conditions = [
    eq(caseEvents.tenantId, query.tenantId),
    eq(caseEvents.caseId, query.caseId),
  ];

  if (query.types && query.types.length > 0) {
    conditions.push(inArray(caseEvents.eventType, query.types));
  }
  if (query.from) {
    conditions.push(gte(caseEvents.occurredAt, query.from));
  }
  if (query.to) {
    conditions.push(lte(caseEvents.occurredAt, query.to));
  }

  if (query.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString("utf8"),
      );
      if (decoded.occurredAt && decoded.id) {
        const cursorDate = new Date(decoded.occurredAt);
        if (isDesc) {
          conditions.push(
            or(
              lt(caseEvents.occurredAt, cursorDate),
              and(
                eq(caseEvents.occurredAt, cursorDate),
                lt(caseEvents.id, decoded.id),
              ),
            )!,
          );
        } else {
          conditions.push(
            or(
              gt(caseEvents.occurredAt, cursorDate),
              and(
                eq(caseEvents.occurredAt, cursorDate),
                gt(caseEvents.id, decoded.id),
              ),
            )!,
          );
        }
      }
    } catch {
      // Invalid cursor ignored
    }
  }

  const orderByClauses = isDesc
    ? [desc(caseEvents.occurredAt), desc(caseEvents.id)]
    : [asc(caseEvents.occurredAt), asc(caseEvents.id)];

  const rows = await executor
    .select()
    .from(caseEvents)
    .where(and(...conditions))
    .orderBy(...orderByClauses)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1]!;
    nextCursor = Buffer.from(
      JSON.stringify({
        occurredAt: lastItem.occurredAt.toISOString(),
        id: lastItem.id,
      }),
    ).toString("base64url");
  }

  return { items, nextCursor };
}
