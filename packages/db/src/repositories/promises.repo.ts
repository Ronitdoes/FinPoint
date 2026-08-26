import { and, desc, eq } from "drizzle-orm";
import {
  promisesToPay,
  type PromiseToPay,
  type NewPromiseToPay,
} from "../schema/promises";
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
