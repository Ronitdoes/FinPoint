import { and, desc, eq } from "drizzle-orm";
import {
  subscriptions,
  type Subscription,
  type NewSubscription,
} from "../schema/subscriptions";
import { type RepoContext, getExecutor } from "./types";

export interface CreateSubscriptionInput {
  tenantId: string;
  customerId: string;
  planName?: string;
  amount: bigint;
  currency: string;
  status?: NewSubscription["status"];
  provider: NewSubscription["provider"];
  providerSubscriptionId: string;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelledAt?: Date;
}

export interface UpdateSubscriptionStatusInput {
  tenantId: string;
  subscriptionId: string;
  status: NewSubscription["status"];
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelledAt?: Date;
}

export async function createSubscription(
  ctx: RepoContext,
  input: CreateSubscriptionInput,
): Promise<Subscription> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(subscriptions)
    .values({
      tenantId: input.tenantId,
      customerId: input.customerId,
      planName: input.planName,
      amount: input.amount,
      currency: input.currency,
      status: input.status ?? "ACTIVE",
      provider: input.provider,
      providerSubscriptionId: input.providerSubscriptionId,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      cancelledAt: input.cancelledAt,
    })
    .returning();
  return created;
}

export async function findSubscriptionById(
  ctx: RepoContext,
  { tenantId, subscriptionId }: { tenantId: string; subscriptionId: string },
): Promise<Subscription | null> {
  const executor = getExecutor(ctx);
  const [subscription] = await executor
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.id, subscriptionId),
      ),
    )
    .limit(1);
  return subscription ?? null;
}

export async function findSubscriptionByProviderId(
  ctx: RepoContext,
  {
    tenantId,
    provider,
    providerSubscriptionId,
  }: {
    tenantId: string;
    provider: NewSubscription["provider"];
    providerSubscriptionId: string;
  },
): Promise<Subscription | null> {
  const executor = getExecutor(ctx);
  const [subscription] = await executor
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.provider, provider),
        eq(subscriptions.providerSubscriptionId, providerSubscriptionId),
      ),
    )
    .limit(1);
  return subscription ?? null;
}

export async function updateSubscriptionStatus(
  ctx: RepoContext,
  input: UpdateSubscriptionStatusInput,
): Promise<Subscription | null> {
  const executor = getExecutor(ctx);
  const updateData: Partial<NewSubscription> = {
    status: input.status,
    updatedAt: new Date(),
  };
  if (input.currentPeriodStart !== undefined)
    updateData.currentPeriodStart = input.currentPeriodStart;
  if (input.currentPeriodEnd !== undefined)
    updateData.currentPeriodEnd = input.currentPeriodEnd;
  if (input.cancelledAt !== undefined) updateData.cancelledAt = input.cancelledAt;

  const [updated] = await executor
    .update(subscriptions)
    .set(updateData)
    .where(
      and(
        eq(subscriptions.tenantId, input.tenantId),
        eq(subscriptions.id, input.subscriptionId),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function listSubscriptionsForCustomer(
  ctx: RepoContext,
  {
    tenantId,
    customerId,
    limit = 50,
    offset = 0,
  }: { tenantId: string; customerId: string; limit?: number; offset?: number },
): Promise<Subscription[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.customerId, customerId),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(limit)
    .offset(offset);
}
