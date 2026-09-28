import { and, eq, inArray } from "drizzle-orm";
import {
  paymentAttempts,
  type PaymentAttempt,
  type NewPaymentAttempt,
} from "../schema/payments";
import { type RepoContext, getExecutor } from "./types";

export interface CreatePaymentAttemptInput {
  tenantId: string;
  paymentId: string;
  attemptNumber: number;
  initiatedBy: NewPaymentAttempt["initiatedBy"];
  idempotencyKey: string;
  status: NewPaymentAttempt["status"];
  providerReference?: string;
  failureCode?: string;
  error?: Record<string, unknown>;
  requestedAt: Date;
  resolvedAt?: Date;
}

export interface ResolvePaymentAttemptInput {
  tenantId: string;
  attemptId: string;
  status: NewPaymentAttempt["status"];
  providerReference?: string;
  failureCode?: string;
  error?: Record<string, unknown>;
  resolvedAt?: Date;
}

export async function createPaymentAttempt(
  ctx: RepoContext,
  input: CreatePaymentAttemptInput,
): Promise<PaymentAttempt> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(paymentAttempts)
    .values({
      tenantId: input.tenantId,
      paymentId: input.paymentId,
      attemptNumber: input.attemptNumber,
      initiatedBy: input.initiatedBy,
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      providerReference: input.providerReference,
      failureCode: input.failureCode,
      error: input.error,
      requestedAt: input.requestedAt,
      resolvedAt: input.resolvedAt,
    })
    .returning();
  return created;
}

export async function findPaymentAttemptsByPaymentId(
  ctx: RepoContext,
  { tenantId, paymentId }: { tenantId: string; paymentId: string },
): Promise<PaymentAttempt[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.tenantId, tenantId),
        eq(paymentAttempts.paymentId, paymentId),
      ),
    )
    .orderBy(paymentAttempts.attemptNumber);
}

export async function findPaymentAttemptByNumber(
  ctx: RepoContext,
  {
    tenantId,
    paymentId,
    attemptNumber,
  }: { tenantId: string; paymentId: string; attemptNumber: number },
): Promise<PaymentAttempt | null> {
  const executor = getExecutor(ctx);
  const [attempt] = await executor
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.tenantId, tenantId),
        eq(paymentAttempts.paymentId, paymentId),
        eq(paymentAttempts.attemptNumber, attemptNumber),
      ),
    )
    .limit(1);
  return attempt ?? null;
}

export async function findPaymentAttemptByIdempotencyKey(
  ctx: RepoContext,
  { tenantId, idempotencyKey }: { tenantId: string; idempotencyKey: string },
): Promise<PaymentAttempt | null> {
  const executor = getExecutor(ctx);
  const [attempt] = await executor
    .select()
    .from(paymentAttempts)
    .where(
      and(
        eq(paymentAttempts.tenantId, tenantId),
        eq(paymentAttempts.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return attempt ?? null;
}

/**
 * Guarded conditional resolve (CONVENTIONS §9): only a non-terminal attempt
 * (`REQUESTED` or `UNKNOWN`) may transition. Terminal `SUCCEEDED`/`FAILED` rows
 * are immutable — a concurrent winner's write sticks and late losers get `null`
 * (no row matched) instead of overwriting history. Callers MUST treat `null` as
 * "already resolved by a concurrent winner" (duplicate/already-resolved) and
 * MUST NOT throw 500: execution.service.ts falls back to the pre-read `attempt`
 * (`resolvedAttempt ?? attempt`), refresh.service.ts / executing-sweeper.ts ignore
 * the return inside their atomic transaction (payment + action writes still commit).
 * Returns the updated row, or `null` when the row is missing, tenant-mismatched,
 * or already terminal (race lost).
 */
export async function resolvePaymentAttempt(
  ctx: RepoContext,
  input: ResolvePaymentAttemptInput,
): Promise<PaymentAttempt | null> {
  const executor = getExecutor(ctx);
  const [resolved] = await executor
    .update(paymentAttempts)
    .set({
      status: input.status,
      providerReference: input.providerReference,
      failureCode: input.failureCode,
      error: input.error,
      resolvedAt: input.resolvedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(paymentAttempts.tenantId, input.tenantId),
        eq(paymentAttempts.id, input.attemptId),
        inArray(paymentAttempts.status, ["REQUESTED", "UNKNOWN"]),
      ),
    )
    .returning();
  return resolved ?? null;
}
