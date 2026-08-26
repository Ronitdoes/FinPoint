import { and, desc, eq } from "drizzle-orm";
import {
  caseEvents,
  type CaseEvent,
  type NewCaseEvent,
} from "../schema/audit";
import { type RepoContext, getExecutor } from "./types";

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

/**
 * Appends a case timeline event (strictly append-only — no update or delete operations).
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
      description: input.description,
      payload: input.payload ?? {},
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
    .orderBy(desc(caseEvents.occurredAt))
    .limit(limit)
    .offset(offset);
}
