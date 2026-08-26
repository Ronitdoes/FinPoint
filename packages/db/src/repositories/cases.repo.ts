import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
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
  closedAt?: Date;
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

  const [updated] = await executor
    .update(recoveryCases)
    .set({
      status: input.to,
      statusReason: input.reason ?? null,
      closedAt: closedAt,
      updatedAt: new Date(),
    })
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
