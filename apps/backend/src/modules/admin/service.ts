import type { Database } from "@repo/db";
import type { Repositories } from "../../plugins/db";
import type Redis from "ioredis";
import { hashPassword, generateApiKey } from "../../lib/crypto";
import {
  ConflictError,
  NotFoundError,
} from "../../lib/errors";
import type {
  CreateUserInput,
  UpdateUserInput,
  CreateApiKeyInput,
  AdminUserResponse,
  CreatedApiKeyResponse,
  ApiKeySummaryResponse,
} from "./types";
import type { UserRole, UserStatus } from "@repo/domain";

export async function createTenantUser(params: {
  db: Database;
  repos: Repositories;
  tenantId: string;
  input: CreateUserInput;
}): Promise<AdminUserResponse> {
  const existing = await params.repos.findUserByEmail(
    { db: params.db },
    { tenantId: params.tenantId, email: params.input.email.toLowerCase().trim() },
  );

  if (existing) {
    throw new ConflictError(
      `A user with email '${params.input.email}' already exists in this tenant`,
      "DUPLICATE_USER",
    );
  }

  const passwordHash = await hashPassword(params.input.password);

  const user = await params.repos.createUser(
    { db: params.db },
    {
      tenantId: params.tenantId,
      email: params.input.email.toLowerCase().trim(),
      name: params.input.name,
      role: params.input.role,
      passwordHash,
      status: "ACTIVE",
    },
  );

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    status: user.status as UserStatus,
    tenantId: user.tenantId,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function updateTenantUser(params: {
  db: Database;
  repos: Repositories;
  redisClient: Redis | null;
  tenantId: string;
  userId: string;
  input: UpdateUserInput;
}): Promise<AdminUserResponse> {
  const existing = await params.repos.findUserById(
    { db: params.db },
    { tenantId: params.tenantId, userId: params.userId },
  );

  if (!existing) {
    throw new NotFoundError(`User with ID '${params.userId}' not found`);
  }

  const updated = await params.repos.updateUser(
    { db: params.db },
    {
      tenantId: params.tenantId,
      userId: params.userId,
      name: params.input.name,
      role: params.input.role,
      status: params.input.status,
    },
  );

  if (!updated) {
    throw new NotFoundError(`User with ID '${params.userId}' not found`);
  }

  // If status is changed to DISABLED, immediately revoke all active sessions
  if (params.input.status === "DISABLED") {
    await params.repos.revokeAllUserSessions(
      { db: params.db },
      { userId: params.userId },
    );
  }

  return {
    id: updated.id,
    email: updated.email,
    name: updated.name,
    role: updated.role as UserRole,
    status: updated.status as UserStatus,
    tenantId: updated.tenantId,
    lastLoginAt: updated.lastLoginAt,
    createdAt: updated.createdAt,
    updatedAt: updated.updatedAt,
  };
}

export async function listTenantUsers(params: {
  db: Database;
  repos: Repositories;
  tenantId: string;
}): Promise<AdminUserResponse[]> {
  const users = await params.repos.listUsersByTenant(
    { db: params.db },
    { tenantId: params.tenantId },
  );

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role as UserRole,
    status: u.status as UserStatus,
    tenantId: u.tenantId,
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  }));
}

export async function createTenantApiKey(params: {
  db: Database;
  repos: Repositories;
  tenantId: string;
  createdBy?: string;
  input: CreateApiKeyInput;
}): Promise<CreatedApiKeyResponse> {
  const { rawKey, prefix, keyHash } = generateApiKey(params.tenantId);

  const apiKey = await params.repos.createApiKey(
    { db: params.db },
    {
      tenantId: params.tenantId,
      name: params.input.name,
      keyHash,
      scopes: params.input.scopes ?? ["events:write"],
      createdBy: params.createdBy,
    },
  );

  return {
    id: apiKey.id,
    name: apiKey.name,
    key: rawKey, // Plaintext shown ONCE
    prefix,
    scopes: apiKey.scopes,
    createdAt: apiKey.createdAt,
  };
}

export async function revokeTenantApiKey(params: {
  db: Database;
  repos: Repositories;
  redisClient: Redis | null;
  tenantId: string;
  id: string;
}): Promise<void> {
  const revoked = await params.repos.revokeApiKey(
    { db: params.db },
    { tenantId: params.tenantId, id: params.id },
  );

  if (!revoked) {
    throw new NotFoundError(`API key with ID '${params.id}' not found`);
  }

  // Invalidate Redis cache
  if (params.redisClient && params.redisClient.status === "ready") {
    await params.redisClient.del(`apikey:${revoked.keyHash}`).catch(() => {});
  }
}

export async function listTenantApiKeys(params: {
  db: Database;
  repos: Repositories;
  tenantId: string;
}): Promise<ApiKeySummaryResponse[]> {
  const keys = await params.repos.listApiKeys(
    { db: params.db },
    { tenantId: params.tenantId },
  );

  const tenantPrefix = params.tenantId.replace(/-/g, "").slice(0, 8);

  return keys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: `rrk_${tenantPrefix}_${k.keyHash.slice(0, 4)}...`,
    scopes: k.scopes,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    createdAt: k.createdAt,
  }));
}
