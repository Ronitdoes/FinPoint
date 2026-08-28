import { and, desc, eq, isNull, or } from "drizzle-orm";
import { customers, type Customer, type NewCustomer } from "../schema/customers";
import { type RepoContext, getExecutor } from "./types";

export interface CreateCustomerInput {
  tenantId: string;
  externalRef?: string;
  name: string;
  email?: string;
  phone?: string;
  status?: NewCustomer["status"];
  lifetimeValue?: bigint;
  optedOut?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UpdateCustomerInput {
  tenantId: string;
  customerId: string;
  name?: string;
  email?: string;
  phone?: string;
  status?: NewCustomer["status"];
  lifetimeValue?: bigint;
  optedOut?: boolean;
  metadata?: Record<string, unknown>;
  deletedAt?: Date | null;
}

export async function createCustomer(
  ctx: RepoContext,
  input: CreateCustomerInput,
): Promise<Customer> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(customers)
    .values({
      tenantId: input.tenantId,
      externalRef: input.externalRef,
      name: input.name,
      email: input.email,
      phone: input.phone,
      status: input.status ?? "ACTIVE",
      lifetimeValue: input.lifetimeValue ?? 0n,
      optedOut: input.optedOut ?? false,
      metadata: input.metadata ?? {},
    })
    .returning();
  return created;
}

export async function findCustomerById(
  ctx: RepoContext,
  { tenantId, customerId }: { tenantId: string; customerId: string },
): Promise<Customer | null> {
  const executor = getExecutor(ctx);
  const [customer] = await executor
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.tenantId, tenantId),
        eq(customers.id, customerId),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);
  return customer ?? null;
}

export async function findCustomerByExternalRef(
  ctx: RepoContext,
  { tenantId, externalRef }: { tenantId: string; externalRef: string },
): Promise<Customer | null> {
  const executor = getExecutor(ctx);
  const [customer] = await executor
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.tenantId, tenantId),
        eq(customers.externalRef, externalRef),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);
  return customer ?? null;
}

export async function findCustomerByEmail(
  ctx: RepoContext,
  { tenantId, email }: { tenantId: string; email: string },
): Promise<Customer | null> {
  const executor = getExecutor(ctx);
  const [customer] = await executor
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.tenantId, tenantId),
        eq(customers.email, email),
        isNull(customers.deletedAt),
      ),
    )
    .limit(1);
  return customer ?? null;
}

export async function findCustomerByPhone(
  ctx: RepoContext,
  { tenantId, phone }: { tenantId: string; phone: string },
): Promise<Customer | null> {
  const executor = getExecutor(ctx);
  const normalized = phone.startsWith("+") ? phone : `+${phone}`;
  const withoutPlus = phone.replace(/^\+/, "");
  const [customer] = await executor
    .select()
    .from(customers)
    .where(
      and(
        eq(customers.tenantId, tenantId),
        or(
          eq(customers.phone, phone),
          eq(customers.phone, normalized),
          eq(customers.phone, withoutPlus),
        ),
        isNull(customers.deletedAt),
      ),
    )
    .orderBy(desc(customers.createdAt))
    .limit(1);
  return customer ?? null;
}

export async function findFirstCustomerByPhone(
  ctx: RepoContext,
  { phone }: { phone: string },
): Promise<Customer | null> {
  const executor = getExecutor(ctx);
  const normalized = phone.startsWith("+") ? phone : `+${phone}`;
  const withoutPlus = phone.replace(/^\+/, "");
  const [customer] = await executor
    .select()
    .from(customers)
    .where(
      and(
        or(
          eq(customers.phone, phone),
          eq(customers.phone, normalized),
          eq(customers.phone, withoutPlus),
        ),
        isNull(customers.deletedAt),
      ),
    )
    .orderBy(desc(customers.createdAt))
    .limit(1);
  return customer ?? null;
}

export async function updateCustomer(
  ctx: RepoContext,
  input: UpdateCustomerInput,
): Promise<Customer | null> {
  const executor = getExecutor(ctx);
  const updateData: Partial<NewCustomer> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) updateData.name = input.name;
  if (input.email !== undefined) updateData.email = input.email;
  if (input.phone !== undefined) updateData.phone = input.phone;
  if (input.status !== undefined) updateData.status = input.status;
  if (input.lifetimeValue !== undefined) updateData.lifetimeValue = input.lifetimeValue;
  if (input.metadata !== undefined) updateData.metadata = input.metadata;
  if (input.deletedAt !== undefined) updateData.deletedAt = input.deletedAt;

  if (input.optedOut !== undefined) {
    updateData.optedOut = input.optedOut;
    updateData.optedOutAt = input.optedOut ? new Date() : null;
  }

  const [updated] = await executor
    .update(customers)
    .set(updateData)
    .where(and(eq(customers.tenantId, input.tenantId), eq(customers.id, input.customerId)))
    .returning();
  return updated ?? null;
}

export async function setCustomerOptOut(
  ctx: RepoContext,
  { tenantId, customerId, optedOut }: { tenantId: string; customerId: string; optedOut: boolean },
): Promise<Customer | null> {
  return await updateCustomer(ctx, {
    tenantId,
    customerId,
    optedOut,
  });
}

export async function listCustomersByTenant(
  ctx: RepoContext,
  { tenantId, limit = 50, offset = 0 }: { tenantId: string; limit?: number; offset?: number },
): Promise<Customer[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, tenantId), isNull(customers.deletedAt)))
    .limit(limit)
    .offset(offset);
}
