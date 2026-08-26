import { and, desc, eq, sql } from "drizzle-orm";
import {
  recoveryOutcomes,
  recoveryCostEntries,
  type RecoveryOutcome,
  type NewRecoveryOutcome,
  type RecoveryCostEntry,
  type NewRecoveryCostEntry,
} from "../schema/outcomes";
import { type RepoContext, getExecutor } from "./types";
import type { Tx } from "./tx";

export interface RecordOutcomeInput {
  tenantId: string;
  caseId: string;
  paymentId: string;
  baselineAmount: bigint;
  recoveredAmount: bigint;
  recoveryCost?: bigint;
  attributionMethod: string;
  attributionWindowHours: number;
  recoveredAt: Date;
  recordedAt?: Date;
}

export interface RecordCostEntryInput {
  tenantId: string;
  caseId: string;
  category: NewRecoveryCostEntry["category"];
  amount: bigint;
  currency: string;
  metadata?: Record<string, unknown>;
  incurredAt: Date;
  createdAt?: Date;
}

/**
 * Records an authoritative financial outcome inside a transaction.
 * Uses ON CONFLICT (case_id) DO NOTHING to enforce exactly one outcome per case idempotently.
 * Returns the recorded outcome (or existing outcome on idempotent replay).
 */
export async function recordOutcomeInTx(
  tx: Tx,
  input: RecordOutcomeInput,
): Promise<RecoveryOutcome> {
  const inserted = await tx
    .insert(recoveryOutcomes)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      paymentId: input.paymentId,
      baselineAmount: input.baselineAmount,
      recoveredAmount: input.recoveredAmount,
      recoveryCost: input.recoveryCost ?? 0n,
      attributionMethod: input.attributionMethod,
      attributionWindowHours: input.attributionWindowHours,
      recoveredAt: input.recoveredAt,
      recordedAt: input.recordedAt ?? new Date(),
    })
    .onConflictDoNothing({
      target: recoveryOutcomes.caseId,
    })
    .returning();

  if (inserted.length > 0) {
    return inserted[0];
  }

  // Row already existed: query and return the authoritative outcome
  const [existing] = await tx
    .select()
    .from(recoveryOutcomes)
    .where(
      and(
        eq(recoveryOutcomes.tenantId, input.tenantId),
        eq(recoveryOutcomes.caseId, input.caseId),
      ),
    )
    .limit(1);

  return existing;
}

export async function findOutcomeByCaseId(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<RecoveryOutcome | null> {
  const executor = getExecutor(ctx);
  const [outcome] = await executor
    .select()
    .from(recoveryOutcomes)
    .where(
      and(
        eq(recoveryOutcomes.tenantId, tenantId),
        eq(recoveryOutcomes.caseId, caseId),
      ),
    )
    .limit(1);
  return outcome ?? null;
}

/**
 * Appends a recovery cost entry to the immutable ledger (append-only).
 */
export async function recordCostEntry(
  ctx: RepoContext,
  input: RecordCostEntryInput,
): Promise<RecoveryCostEntry> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(recoveryCostEntries)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      category: input.category,
      amount: input.amount,
      currency: input.currency,
      metadata: input.metadata ?? {},
      incurredAt: input.incurredAt,
      createdAt: input.createdAt ?? new Date(),
    })
    .returning();
  return created;
}

/**
 * Lists chronological cost entries for a case (append-only reader).
 */
export async function listCostEntriesForCase(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<RecoveryCostEntry[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(recoveryCostEntries)
    .where(
      and(
        eq(recoveryCostEntries.tenantId, tenantId),
        eq(recoveryCostEntries.caseId, caseId),
      ),
    )
    .orderBy(desc(recoveryCostEntries.incurredAt));
}
