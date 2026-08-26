import { and, eq } from "drizzle-orm";
import { payments, type Payment, type NewPayment } from "../schema/payments";
import { type RepoContext, getExecutor } from "./types";

export interface CreatePaymentInput {
  tenantId: string;
  customerId: string;
  subscriptionId?: string;
  amount: bigint;
  currency: string;
  status?: NewPayment["status"];
  provider: NewPayment["provider"];
  providerPaymentId: string;
  failureCode?: string;
  failureMessage?: string;
  methodMetadata?: Record<string, unknown>;
  occurredAt: Date;
  paidAt?: Date;
  refundedAt?: Date;
  disputedAt?: Date;
}

export interface UpdatePaymentStatusInput {
  tenantId: string;
  paymentId: string;
  status: NewPayment["status"];
  failureCode?: string;
  failureMessage?: string;
  paidAt?: Date;
  refundedAt?: Date;
  disputedAt?: Date;
}

export async function createPayment(
  ctx: RepoContext,
  input: CreatePaymentInput,
): Promise<Payment> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(payments)
    .values({
      tenantId: input.tenantId,
      customerId: input.customerId,
      subscriptionId: input.subscriptionId,
      amount: input.amount,
      currency: input.currency,
      status: input.status ?? "CREATED",
      provider: input.provider,
      providerPaymentId: input.providerPaymentId,
      failureCode: input.failureCode,
      failureMessage: input.failureMessage,
      methodMetadata: input.methodMetadata ?? {},
      occurredAt: input.occurredAt,
      paidAt: input.paidAt,
      refundedAt: input.refundedAt,
      disputedAt: input.disputedAt,
    })
    .returning();
  return created;
}

export async function findPaymentById(
  ctx: RepoContext,
  { tenantId, paymentId }: { tenantId: string; paymentId: string },
): Promise<Payment | null> {
  const executor = getExecutor(ctx);
  const [payment] = await executor
    .select()
    .from(payments)
    .where(and(eq(payments.tenantId, tenantId), eq(payments.id, paymentId)))
    .limit(1);
  return payment ?? null;
}

export async function findPaymentByProviderPaymentId(
  ctx: RepoContext,
  {
    tenantId,
    provider,
    providerPaymentId,
  }: {
    tenantId: string;
    provider: NewPayment["provider"];
    providerPaymentId: string;
  },
): Promise<Payment | null> {
  const executor = getExecutor(ctx);
  const [payment] = await executor
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.tenantId, tenantId),
        eq(payments.provider, provider),
        eq(payments.providerPaymentId, providerPaymentId),
      ),
    )
    .limit(1);
  return payment ?? null;
}

export async function updatePaymentStatus(
  ctx: RepoContext,
  input: UpdatePaymentStatusInput,
): Promise<Payment | null> {
  const executor = getExecutor(ctx);
  const updateData: Partial<NewPayment> = {
    status: input.status,
    updatedAt: new Date(),
  };
  if (input.failureCode !== undefined) updateData.failureCode = input.failureCode;
  if (input.failureMessage !== undefined) updateData.failureMessage = input.failureMessage;
  if (input.paidAt !== undefined) updateData.paidAt = input.paidAt;
  if (input.refundedAt !== undefined) updateData.refundedAt = input.refundedAt;
  if (input.disputedAt !== undefined) updateData.disputedAt = input.disputedAt;

  const [updated] = await executor
    .update(payments)
    .set(updateData)
    .where(and(eq(payments.tenantId, input.tenantId), eq(payments.id, input.paymentId)))
    .returning();
  return updated ?? null;
}

export async function listPaymentsForCustomer(
  ctx: RepoContext,
  { tenantId, customerId, limit = 50, offset = 0 }: { tenantId: string; customerId: string; limit?: number; offset?: number },
): Promise<Payment[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(payments)
    .where(and(eq(payments.tenantId, tenantId), eq(payments.customerId, customerId)))
    .limit(limit)
    .offset(offset);
}
