import { and, desc, eq, gte, inArray, lt, lte, notInArray, or, sql } from "drizzle-orm";
import {
  recoveryCases,
  type RecoveryCase,
  type NewRecoveryCase,
} from "../schema/cases";
import type { CaseStatus } from "@repo/domain";
import { isTerminal } from "@repo/domain";
import { type RepoContext, getExecutor } from "./types";
import type { Tx } from "./tx";

export interface CreateCaseInput {
  tenantId: string;
  customerId: string;
  riskId?: string;
  riskType: NewRecoveryCase["riskType"];
  sourceEntityType: string;
  sourceEntityId: string;
  amountAtRisk: bigint;
  currency: string;
  riskScore: number;
  status?: CaseStatus;
  statusReason?: string;
  stopConditions?: string[];
  assignedTo?: string;
  workflowId?: string;
  attributionWindowHours?: number;
  openedAt?: Date;
  closedAt?: Date;
}

export interface TransitionCaseStatusInput {
  tenantId: string;
  caseId: string;
  from: CaseStatus[];
  to: CaseStatus;
  reason?: string;
  workflowId?: string;
  closedAt?: Date;
}

export interface ListCasesQuery {
  tenantId: string;
  status?: CaseStatus;
  riskType?: NewRecoveryCase["riskType"];
  customerId?: string;
  minAmount?: bigint | number;
  openedFrom?: Date;
  openedTo?: Date;
  limit?: number;
  cursor?: string;
}

export interface ListCasesResult {
  items: RecoveryCase[];
  nextCursor?: string;
}

/**
 * Computes next per-tenant case number atomically via transaction advisory lock.
 */
export async function nextCaseNumber(
  ctx: RepoContext,
  { tenantId }: { tenantId: string },
): Promise<number> {
  const executor = getExecutor(ctx);

  // Acquire transaction-scoped advisory lock for this tenant's case sequence
  await executor.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId} || ':case_seq'))`,
  );

  const result = await executor.execute<{ next_seq: number }>(
    sql`SELECT COALESCE(MAX(case_number), 0) + 1 AS next_seq FROM recovery_cases WHERE tenant_id = ${tenantId}`,
  );

  const nextSeq = Number(result[0]?.next_seq ?? 1);
  return nextSeq;
}

/**
 * Creates a recovery case within an explicit transaction.
 */
export async function createCaseInTx(
  tx: Tx,
  input: CreateCaseInput,
): Promise<RecoveryCase> {
  const caseNum = await nextCaseNumber({ tx }, { tenantId: input.tenantId });

  const [created] = await tx
    .insert(recoveryCases)
    .values({
      tenantId: input.tenantId,
      caseNumber: caseNum,
      customerId: input.customerId,
      riskId: input.riskId,
      riskType: input.riskType,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      amountAtRisk: input.amountAtRisk,
      currency: input.currency,
      riskScore: input.riskScore,
      status: input.status ?? "DETECTED",
      statusReason: input.statusReason,
      stopConditions: input.stopConditions ?? [],
      assignedTo: input.assignedTo,
      workflowId: input.workflowId,
      attributionWindowHours: input.attributionWindowHours ?? 72,
      openedAt: input.openedAt ?? new Date(),
      closedAt: input.closedAt,
    })
    .returning();

  return created;
}

/**
 * General case creation helper (delegates to executor in ctx).
 */
export async function createCase(
  ctx: RepoContext,
  input: CreateCaseInput,
): Promise<RecoveryCase> {
  const executor = getExecutor(ctx);
  const caseNum = await nextCaseNumber(ctx, { tenantId: input.tenantId });

  const [created] = await executor
    .insert(recoveryCases)
    .values({
      tenantId: input.tenantId,
      caseNumber: caseNum,
      customerId: input.customerId,
      riskId: input.riskId,
      riskType: input.riskType,
      sourceEntityType: input.sourceEntityType,
      sourceEntityId: input.sourceEntityId,
      amountAtRisk: input.amountAtRisk,
      currency: input.currency,
      riskScore: input.riskScore,
      status: input.status ?? "DETECTED",
      statusReason: input.statusReason,
      stopConditions: input.stopConditions ?? [],
      assignedTo: input.assignedTo,
      workflowId: input.workflowId,
      attributionWindowHours: input.attributionWindowHours ?? 72,
      openedAt: input.openedAt ?? new Date(),
      closedAt: input.closedAt,
    })
    .returning();

  return created;
}

/**
 * Executes a concurrency-safe, guarded state transition for a recovery case.
 * Returns null if the current case status is not in the allowed `from` list (race or illegal jump).
 */
export async function transitionCaseStatus(
  ctx: RepoContext,
  input: TransitionCaseStatusInput,
): Promise<RecoveryCase | null> {
  if (!input.from || input.from.length === 0) {
    return null;
  }

  const executor = getExecutor(ctx);
  const willClose = isTerminal(input.to);
  const closedAt = input.closedAt ?? (willClose ? new Date() : null);

  const updateSet: Partial<NewRecoveryCase> = {
    status: input.to,
    statusReason: input.reason ?? null,
    closedAt: closedAt,
    updatedAt: new Date(),
  };

  if (input.workflowId) {
    updateSet.workflowId = input.workflowId;
  }

  const [updated] = await executor
    .update(recoveryCases)
    .set(updateSet)
    .where(
      and(
        eq(recoveryCases.tenantId, input.tenantId),
        eq(recoveryCases.id, input.caseId),
        inArray(recoveryCases.status, input.from),
      ),
    )
    .returning();

  return updated ?? null;
}

export async function findCaseById(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<RecoveryCase | null> {
  const executor = getExecutor(ctx);
  const [row] = await executor
    .select()
    .from(recoveryCases)
    .where(
      and(eq(recoveryCases.tenantId, tenantId), eq(recoveryCases.id, caseId)),
    )
    .limit(1);
  return row ?? null;
}

export async function findLiveCaseByObligation(
  ctx: RepoContext,
  {
    tenantId,
    sourceEntityType,
    sourceEntityId,
  }: { tenantId: string; sourceEntityType: string; sourceEntityId: string },
): Promise<RecoveryCase | null> {
  const executor = getExecutor(ctx);
  const [row] = await executor
    .select()
    .from(recoveryCases)
    .where(
      and(
        eq(recoveryCases.tenantId, tenantId),
        eq(recoveryCases.sourceEntityType, sourceEntityType),
        eq(recoveryCases.sourceEntityId, sourceEntityId),
        notInArray(recoveryCases.status, ["RECOVERED", "STOPPED", "FAILED"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listCases(
  ctx: RepoContext,
  {
    tenantId,
    status,
    customerId,
    limit = 50,
    offset = 0,
  }: {
    tenantId: string;
    status?: CaseStatus;
    customerId?: string;
    limit?: number;
    offset?: number;
  },
): Promise<RecoveryCase[]> {
  const executor = getExecutor(ctx);
  const conditions = [eq(recoveryCases.tenantId, tenantId)];
  if (status) {
    conditions.push(eq(recoveryCases.status, status));
  }
  if (customerId) {
    conditions.push(eq(recoveryCases.customerId, customerId));
  }

  return await executor
    .select()
    .from(recoveryCases)
    .where(and(...conditions))
    .orderBy(desc(recoveryCases.openedAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Filtered list of recovery cases with cursor-based pagination and strict tenant isolation.
 * Supports status, riskType, customerId, minAmount, openedFrom, openedTo.
 */
export async function listCasesWithCursor(
  ctx: RepoContext,
  query: ListCasesQuery,
): Promise<ListCasesResult> {
  const executor = getExecutor(ctx);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

  const conditions = [eq(recoveryCases.tenantId, query.tenantId)];

  if (query.status) {
    conditions.push(eq(recoveryCases.status, query.status));
  }
  if (query.riskType) {
    conditions.push(eq(recoveryCases.riskType, query.riskType));
  }
  if (query.customerId) {
    conditions.push(eq(recoveryCases.customerId, query.customerId));
  }
  if (query.minAmount !== undefined) {
    const minBig = BigInt(query.minAmount);
    conditions.push(gte(recoveryCases.amountAtRisk, minBig));
  }
  if (query.openedFrom) {
    conditions.push(gte(recoveryCases.openedAt, query.openedFrom));
  }
  if (query.openedTo) {
    conditions.push(lte(recoveryCases.openedAt, query.openedTo));
  }

  if (query.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString("utf8"),
      );
      if (decoded.openedAt && decoded.id) {
        const cursorDate = new Date(decoded.openedAt);
        conditions.push(
          or(
            lt(recoveryCases.openedAt, cursorDate),
            and(
              eq(recoveryCases.openedAt, cursorDate),
              lt(recoveryCases.id, decoded.id),
            ),
          )!,
        );
      }
    } catch {
      // Invalid cursor ignored
    }
  }

  const rows = await executor
    .select()
    .from(recoveryCases)
    .where(and(...conditions))
    .orderBy(desc(recoveryCases.openedAt), desc(recoveryCases.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | undefined;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = Buffer.from(
      JSON.stringify({
        openedAt: lastItem.openedAt.toISOString(),
        id: lastItem.id,
      }),
      "utf8",
    ).toString("base64url");
  }

  return { items, nextCursor };
}

export async function assignCase(
  ctx: RepoContext,
  {
    tenantId,
    caseId,
    assignedTo,
  }: { tenantId: string; caseId: string; assignedTo: string | null },
): Promise<RecoveryCase | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(recoveryCases)
    .set({
      assignedTo,
      updatedAt: new Date(),
    })
    .where(
      and(eq(recoveryCases.tenantId, tenantId), eq(recoveryCases.id, caseId)),
    )
    .returning();
  return updated ?? null;
}

export async function attachWorkflowToCase(
  ctx: RepoContext,
  {
    tenantId,
    caseId,
    workflowId,
  }: { tenantId: string; caseId: string; workflowId: string },
): Promise<RecoveryCase | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(recoveryCases)
    .set({
      workflowId,
      updatedAt: new Date(),
    })
    .where(
      and(eq(recoveryCases.tenantId, tenantId), eq(recoveryCases.id, caseId)),
    )
    .returning();
  return updated ?? null;
}

export async function findLiveCasesForCustomer(
  ctx: RepoContext,
  {
    tenantId,
    customerId,
  }: { tenantId: string; customerId: string },
): Promise<RecoveryCase[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(recoveryCases)
    .where(
      and(
        eq(recoveryCases.tenantId, tenantId),
        eq(recoveryCases.customerId, customerId),
        notInArray(recoveryCases.status, ["RECOVERED", "STOPPED", "FAILED"]),
      ),
    )
    .orderBy(desc(recoveryCases.openedAt));
}

