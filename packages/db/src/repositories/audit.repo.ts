import { and, desc, eq } from "drizzle-orm";
import {
  auditLogs,
  type AuditLog,
  type NewAuditLog,
} from "../schema/audit";
import { type RepoContext, getExecutor } from "./types";

export interface RecordAuditLogInput {
  tenantId: string;
  caseId?: string;
  actorType: NewAuditLog["actorType"];
  actorId?: string;
  event: string;
  metadata?: Record<string, unknown>;
  correlationId?: string;
  createdAt?: Date;
}

/**
 * Appends an audit log entry (strictly append-only — no update or delete operations).
 */
export async function recordAuditLog(
  ctx: RepoContext,
  input: RecordAuditLogInput,
): Promise<AuditLog> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(auditLogs)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      actorType: input.actorType,
      actorId: input.actorId,
      event: input.event,
      metadata: input.metadata ?? {},
      correlationId: input.correlationId,
      createdAt: input.createdAt ?? new Date(),
    })
    .returning();
  return created;
}

export async function findAuditLogById(
  ctx: RepoContext,
  { tenantId, id }: { tenantId: string; id: number },
): Promise<AuditLog | null> {
  const executor = getExecutor(ctx);
  const [log] = await executor
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.id, id)))
    .limit(1);
  return log ?? null;
}

export async function listAuditLogs(
  ctx: RepoContext,
  {
    tenantId,
    caseId,
    limit = 50,
    offset = 0,
  }: { tenantId: string; caseId?: string; limit?: number; offset?: number },
): Promise<AuditLog[]> {
  const executor = getExecutor(ctx);
  const conditions = [eq(auditLogs.tenantId, tenantId)];
  if (caseId) {
    conditions.push(eq(auditLogs.caseId, caseId));
  }

  return await executor
    .select()
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit)
    .offset(offset);
}
