import { and, eq } from "drizzle-orm";
import { apiKeys, type ApiKey, type NewApiKey } from "../schema/users";
import { type RepoContext, getExecutor } from "./types";

export interface CreateApiKeyInput {
  tenantId: string;
  name: string;
  keyHash: string;
  scopes?: string[];
  createdBy?: string;
}

export async function createApiKey(
  ctx: RepoContext,
  input: CreateApiKeyInput,
): Promise<ApiKey> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(apiKeys)
    .values({
      tenantId: input.tenantId,
      name: input.name,
      keyHash: input.keyHash,
      scopes: input.scopes ?? ["events:write"],
      createdBy: input.createdBy,
    })
    .returning();
  return created;
}

export async function findApiKeyByHash(
  ctx: RepoContext,
  { keyHash }: { keyHash: string },
): Promise<ApiKey | null> {
  const executor = getExecutor(ctx);
  const [apiKey] = await executor
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);
  return apiKey ?? null;
}

export async function findApiKeyById(
  ctx: RepoContext,
  { tenantId, id }: { tenantId: string; id: string },
): Promise<ApiKey | null> {
  const executor = getExecutor(ctx);
  const [apiKey] = await executor
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, id)))
    .limit(1);
  return apiKey ?? null;
}

export async function revokeApiKey(
  ctx: RepoContext,
  { tenantId, id }: { tenantId: string; id: string },
): Promise<ApiKey | null> {
  const executor = getExecutor(ctx);
  const [revoked] = await executor
    .update(apiKeys)
    .set({
      revokedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, id)))
    .returning();
  return revoked ?? null;
}

export async function updateApiKeyLastUsed(
  ctx: RepoContext,
  { id }: { id: string },
): Promise<void> {
  const executor = getExecutor(ctx);
  await executor
    .update(apiKeys)
    .set({
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(apiKeys.id, id));
}

export async function listApiKeys(
  ctx: RepoContext,
  { tenantId }: { tenantId: string },
): Promise<ApiKey[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.tenantId, tenantId));
}
