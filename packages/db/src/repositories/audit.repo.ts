import { and, desc, eq, gte, lte, lt, or } from "drizzle-orm";
import {
  auditLogs,
  auditArchive,
  type AuditLog,
  type NewAuditLog,
  type AuditArchive,
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

export interface ListAuditLogsQuery {
  tenantId: string;
  caseId?: string;
  actorType?: NewAuditLog["actorType"];
  event?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export interface ListAuditLogsResult {
  items: AuditLog[];
  nextCursor: string | null;
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
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit)
    .offset(offset);
}

/**
 * Lists audit logs with cursor pagination and comprehensive compliance filters.
 */
export async function listAuditLogsWithCursor(
  ctx: RepoContext,
  query: ListAuditLogsQuery,
): Promise<ListAuditLogsResult> {
  const executor = getExecutor(ctx);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

  const conditions = [eq(auditLogs.tenantId, query.tenantId)];

  if (query.caseId) {
    conditions.push(eq(auditLogs.caseId, query.caseId));
  }
  if (query.actorType) {
    conditions.push(eq(auditLogs.actorType, query.actorType));
  }
  if (query.event) {
    conditions.push(eq(auditLogs.event, query.event));
  }
  if (query.from) {
    conditions.push(gte(auditLogs.createdAt, query.from));
  }
  if (query.to) {
    conditions.push(lte(auditLogs.createdAt, query.to));
  }

  if (query.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString("utf8"),
      );
      if (decoded.createdAt && decoded.id) {
        const cursorDate = new Date(decoded.createdAt);
        conditions.push(
          or(
            lt(auditLogs.createdAt, cursorDate),
            and(
              eq(auditLogs.createdAt, cursorDate),
              lt(auditLogs.id, decoded.id),
            ),
          )!,
        );
      }
    } catch {
      // Invalid cursor ignored, fallback to start
    }
  }

  const rows = await executor
    .select()
    .from(auditLogs)
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | null = null;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1]!;
    nextCursor = Buffer.from(
      JSON.stringify({
        createdAt: lastItem.createdAt.toISOString(),
        id: lastItem.id,
      }),
    ).toString("base64url");
  }

  return { items, nextCursor };
}

/**
 * Copies expired audit logs to cold storage audit_archive.
 */
export async function archiveAuditLogsBatch(
  ctx: RepoContext,
  {
    cutoffDate,
    batchSize = 500,
  }: { cutoffDate: Date; batchSize?: number },
): Promise<{ archivedCount: number }> {
  const executor = getExecutor(ctx);

  const expiredLogs = await executor
    .select()
    .from(auditLogs)
    .where(lt(auditLogs.createdAt, cutoffDate))
    .orderBy(auditLogs.createdAt, auditLogs.id)
    .limit(batchSize);

  if (expiredLogs.length === 0) {
    return { archivedCount: 0 };
  }

  await executor.insert(auditArchive).values(
    expiredLogs.map((log) => ({
      tenantId: log.tenantId,
      caseId: log.caseId,
      actorType: log.actorType,
      actorId: log.actorId,
      event: log.event,
      metadata: log.metadata,
      correlationId: log.correlationId,
      createdAt: log.createdAt,
      archivedAt: new Date(),
    })),
  );

  return { archivedCount: expiredLogs.length };
}
