import { eq } from "drizzle-orm";
import { tenants, type Tenant, type NewTenant } from "../schema/tenants";
import { type RepoContext, getExecutor } from "./types";

export interface CreateTenantInput {
  name: string;
  slug: string;
  status?: NewTenant["status"];
  settings?: NewTenant["settings"];
}

export interface UpdateTenantInput {
  tenantId: string;
  name?: string;
  status?: NewTenant["status"];
  settings?: NewTenant["settings"];
}

export async function createTenant(
  ctx: RepoContext,
  input: CreateTenantInput,
): Promise<Tenant> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(tenants)
    .values({
      name: input.name,
      slug: input.slug,
      status: input.status ?? "ACTIVE",
      settings: input.settings ?? {},
    })
    .returning();
  return created;
}

export async function findTenantById(
  ctx: RepoContext,
  { tenantId }: { tenantId: string },
): Promise<Tenant | null> {
  const executor = getExecutor(ctx);
  const [tenant] = await executor
    .select()
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  return tenant ?? null;
}

export async function findTenantBySlug(
  ctx: RepoContext,
  { slug }: { slug: string },
): Promise<Tenant | null> {
  const executor = getExecutor(ctx);
  const [tenant] = await executor
    .select()
    .from(tenants)
    .where(eq(tenants.slug, slug))
    .limit(1);
  return tenant ?? null;
}

export async function updateTenant(
  ctx: RepoContext,
  input: UpdateTenantInput,
): Promise<Tenant | null> {
  const executor = getExecutor(ctx);
  const updateData: Partial<NewTenant> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) updateData.name = input.name;
  if (input.status !== undefined) updateData.status = input.status;
  if (input.settings !== undefined) updateData.settings = input.settings;

  const [updated] = await executor
    .update(tenants)
    .set(updateData)
    .where(eq(tenants.id, input.tenantId))
    .returning();
  return updated ?? null;
}

export async function listTenants(
  ctx: RepoContext,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<Tenant[]> {
  const executor = getExecutor(ctx);
  return await executor.select().from(tenants).limit(limit).offset(offset);
}
