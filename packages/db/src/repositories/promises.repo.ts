import { and, desc, eq, lte, sql } from "drizzle-orm";
import {
  promisesToPay,
  type PromiseToPay,
  type NewPromiseToPay,
} from "../schema/promises";
import { recoveryCases } from "../schema/cases";
import { type RepoContext, getExecutor } from "./types";

export interface CreatePromiseToPayInput {
  tenantId: string;
  caseId: string;
  promisedAmount: bigint;
  currency: string;
  promisedByDate: string;
  status?: NewPromiseToPay["status"];
  honoredPaymentId?: string;
  resolvedAt?: Date;
}

export interface ResolvePromiseInput {
  tenantId: string;
  promiseId: string;
  status: NewPromiseToPay["status"];
  honoredPaymentId?: string;
  resolvedAt?: Date;
}

export interface ListPromisesToPayInput {
  tenantId: string;
  status?: NewPromiseToPay["status"];
  customerId?: string;
  caseId?: string;
  limit?: number;
  offset?: number;
}

export interface MarkPromiseHonoredInput {
  tenantId: string;
  promiseId: string;
  paymentId?: string;
  resolvedAt?: Date;
}

export interface MarkPromiseBrokenInput {
  tenantId: string;
  promiseId: string;
  resolvedAt?: Date;
}

export interface MarkPromiseExpiredInput {
  tenantId: string;
  promiseId: string;
  resolvedAt?: Date;
}

export interface FindOverduePromisesInput {
  tenantId: string;
  cutoffDate?: string | Date;
  limit?: number;
}

export async function createPromiseToPay(
  ctx: RepoContext,
  input: CreatePromiseToPayInput,
): Promise<PromiseToPay> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(promisesToPay)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      promisedAmount: input.promisedAmount,
      currency: input.currency,
      promisedByDate: input.promisedByDate,
      status: input.status ?? "MADE",
      honoredPaymentId: input.honoredPaymentId,
      resolvedAt: input.resolvedAt,
    })
    .returning();
  return created;
}

export async function findPromiseById(
  ctx: RepoContext,
  { tenantId, promiseId }: { tenantId: string; promiseId: string },
): Promise<PromiseToPay | null> {
  const executor = getExecutor(ctx);
  const [promise] = await executor
    .select()
    .from(promisesToPay)
    .where(
      and(
        eq(promisesToPay.tenantId, tenantId),
        eq(promisesToPay.id, promiseId),
      ),
    )
    .limit(1);
  return promise ?? null;
}

export async function findPromisesForCase(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<PromiseToPay[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(promisesToPay)
    .where(
      and(eq(promisesToPay.tenantId, tenantId), eq(promisesToPay.caseId, caseId)),
    )
    .orderBy(desc(promisesToPay.createdAt));
}

export async function listPromisesToPay(
  ctx: RepoContext,
  input: ListPromisesToPayInput,
): Promise<PromiseToPay[]> {
  const executor = getExecutor(ctx);
  const limit = input.limit ?? 50;
  const offset = input.offset ?? 0;

  if (input.customerId) {
    // Filter joining recoveryCases on customerId
    const rows = await executor
      .select({ promise: promisesToPay })
      .from(promisesToPay)
      .innerJoin(
        recoveryCases,
        and(
          eq(promisesToPay.caseId, recoveryCases.id),
          eq(recoveryCases.tenantId, input.tenantId),
          eq(recoveryCases.customerId, input.customerId),
        ),
      )
      .where(
        and(
          eq(promisesToPay.tenantId, input.tenantId),
          input.status ? eq(promisesToPay.status, input.status) : undefined,
          input.caseId ? eq(promisesToPay.caseId, input.caseId) : undefined,
        ),
      )
      .orderBy(desc(promisesToPay.createdAt))
      .limit(limit)
      .offset(offset);

    return rows.map((r) => r.promise);
  }

  const conditions = [eq(promisesToPay.tenantId, input.tenantId)];
  if (input.status) {
    conditions.push(eq(promisesToPay.status, input.status));
  }
  if (input.caseId) {
    conditions.push(eq(promisesToPay.caseId, input.caseId));
  }

  return await executor
    .select()
    .from(promisesToPay)
    .where(and(...conditions))
    .orderBy(desc(promisesToPay.createdAt))
    .limit(limit)
    .offset(offset);
}

export async function resolvePromise(
  ctx: RepoContext,
  input: ResolvePromiseInput,
): Promise<PromiseToPay | null> {
  const executor = getExecutor(ctx);
  const updateData: Partial<NewPromiseToPay> = {
    status: input.status,
    resolvedAt: input.resolvedAt ?? new Date(),
    updatedAt: new Date(),
  };
  if (input.honoredPaymentId !== undefined)
    updateData.honoredPaymentId = input.honoredPaymentId;

  const [updated] = await executor
    .update(promisesToPay)
    .set(updateData)
    .where(
      and(
        eq(promisesToPay.tenantId, input.tenantId),
        eq(promisesToPay.id, input.promiseId),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Guarded conditional update: transitions status from MADE -> HONORED.
 * Records the honored payment ID and resolution timestamp.
 */
export async function markPromiseHonored(
  ctx: RepoContext,
  input: MarkPromiseHonoredInput,
): Promise<PromiseToPay | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(promisesToPay)
    .set({
      status: "HONORED",
      honoredPaymentId: input.paymentId ?? null,
      resolvedAt: input.resolvedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(promisesToPay.tenantId, input.tenantId),
        eq(promisesToPay.id, input.promiseId),
        eq(promisesToPay.status, "MADE"),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Guarded conditional update: transitions status from MADE -> BROKEN.
 */
export async function markPromiseBroken(
  ctx: RepoContext,
  input: MarkPromiseBrokenInput,
): Promise<PromiseToPay | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(promisesToPay)
    .set({
      status: "BROKEN",
      resolvedAt: input.resolvedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(promisesToPay.tenantId, input.tenantId),
        eq(promisesToPay.id, input.promiseId),
        eq(promisesToPay.status, "MADE"),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Guarded conditional update: transitions status from MADE -> EXPIRED.
 */
export async function markPromiseExpired(
  ctx: RepoContext,
  input: MarkPromiseExpiredInput,
): Promise<PromiseToPay | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(promisesToPay)
    .set({
      status: "EXPIRED",
      resolvedAt: input.resolvedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(promisesToPay.tenantId, input.tenantId),
        eq(promisesToPay.id, input.promiseId),
        eq(promisesToPay.status, "MADE"),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Finds promises in MADE status past cutoff date for reconciliation.
 */
export async function findOverduePromises(
  ctx: RepoContext,
  input: FindOverduePromisesInput,
): Promise<PromiseToPay[]> {
  const executor = getExecutor(ctx);
  const cutoff =
    input.cutoffDate instanceof Date
      ? input.cutoffDate.toISOString().slice(0, 10)
      : (input.cutoffDate ?? new Date().toISOString().slice(0, 10));

  return await executor
    .select()
    .from(promisesToPay)
    .where(
      and(
        eq(promisesToPay.tenantId, input.tenantId),
        eq(promisesToPay.status, "MADE"),
        lte(promisesToPay.promisedByDate, cutoff),
      ),
    )
    .orderBy(promisesToPay.promisedByDate)
    .limit(input.limit ?? 50);
}
