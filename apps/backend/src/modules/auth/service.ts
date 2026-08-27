import type { Database } from "@repo/db";
import type { Repositories } from "../../plugins/db";
import type Redis from "ioredis";
import type { FastifyBaseLogger } from "fastify";
import type { UserRole } from "@repo/domain";
import {
  hashPassword,
  verifyPassword,
  generateSessionToken,
  sha256,
} from "../../lib/crypto";
import {
  InvalidCredentialsError,
  RateLimitedError,
  NotFoundError,
} from "../../lib/errors";
import {
  recordAuthLogin,
  recordAuthFailure,
} from "@repo/observability";
import type { AuthUserSummary, LoginResponse } from "./types";
import type { RequestAuth } from "../../plugins/auth";

// In-memory rate limit fallback when Redis is absent
interface RateLimitBucket {
  count: number;
  resetAt: number;
}
const localAttemptBuckets = new Map<string, RateLimitBucket>();

async function checkAndIncrementLoginAttempts(
  redis: Redis | null,
  ip: string,
  emailHash: string,
): Promise<void> {
  const key = `login_attempts:${ip}:${emailHash}`;
  const maxAttempts = 5;
  const windowSeconds = 60;

  if (redis && redis.status === "ready") {
    try {
      const attempts = await redis.incr(key);
      if (attempts === 1) {
        await redis.expire(key, windowSeconds);
      }
      if (attempts > maxAttempts) {
        const ttl = await redis.ttl(key);
        throw new RateLimitedError(
          "Too many failed login attempts. Please try again later.",
          ttl > 0 ? ttl : windowSeconds,
        );
      }
      return;
    } catch (err: any) {
      if (err instanceof RateLimitedError) throw err;
      // if Redis error, fall back to in-memory
    }
  }

  // In-memory bucket
  const now = Date.now();
  const bucket = localAttemptBuckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    localAttemptBuckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return;
  }

  bucket.count++;
  if (bucket.count > maxAttempts) {
    const remainingSeconds = Math.ceil((bucket.resetAt - now) / 1000);
    throw new RateLimitedError(
      "Too many failed login attempts. Please try again later.",
      remainingSeconds > 0 ? remainingSeconds : windowSeconds,
    );
  }
}

async function clearLoginAttempts(
  redis: Redis | null,
  ip: string,
  emailHash: string,
): Promise<void> {
  const key = `login_attempts:${ip}:${emailHash}`;
  if (redis && redis.status === "ready") {
    try {
      await redis.del(key);
    } catch {
      // ignore
    }
  }
  localAttemptBuckets.delete(key);
}

export interface LoginParams {
  db: Database;
  repos: Repositories;
  redisClient: Redis | null;
  log: FastifyBaseLogger;
  ip: string;
  userAgent?: string | null;
  email: string;
  password: string;
}

export async function loginUser(
  params: LoginParams,
): Promise<{ rawToken: string; user: AuthUserSummary }> {
  const normalizedEmail = params.email.toLowerCase().trim();
  const emailHash = sha256(normalizedEmail);

  // 1. Rate-limiting check / increment
  await checkAndIncrementLoginAttempts(params.redisClient, params.ip, emailHash);

  // 2. Query user across tenants by email
  const user = await params.repos.findUserByEmailGlobal(
    { db: params.db },
    { email: normalizedEmail },
  );

  if (!user || !user.passwordHash) {
    recordAuthFailure("invalid_credentials");
    params.log.warn(
      { ip: params.ip, emailHash },
      "Failed login attempt: user not found",
    );
    throw new InvalidCredentialsError("Invalid email or password");
  }

  if (user.status !== "ACTIVE") {
    recordAuthFailure("disabled_user");
    params.log.warn(
      { ip: params.ip, emailHash, userId: user.id, status: user.status },
      "Failed login attempt: user account is disabled",
    );
    throw new InvalidCredentialsError("Invalid email or password");
  }

  // 3. Verify argon2id password hash
  const isValid = await verifyPassword(params.password, user.passwordHash);
  if (!isValid) {
    recordAuthFailure("invalid_credentials");
    params.log.warn(
      { ip: params.ip, emailHash, userId: user.id },
      "Failed login attempt: password mismatch",
    );
    throw new InvalidCredentialsError("Invalid email or password");
  }

  // 4. Successful login: clear attempt counter
  await clearLoginAttempts(params.redisClient, params.ip, emailHash);

  // 5. Issue server-side session token
  const rawToken = generateSessionToken();
  const tokenHash = sha256(rawToken);
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours TTL

  const session = await params.repos.createSession(
    { db: params.db },
    {
      userId: user.id,
      tokenHash,
      expiresAt,
      ip: params.ip,
      userAgent: params.userAgent ?? null,
    },
  );

  // Touch lastLoginAt
  await params.repos.updateUser(
    { db: params.db },
    {
      tenantId: user.tenantId,
      userId: user.id,
      lastLoginAt: new Date(),
    },
  );

  // Cache session in Redis (60s hot path)
  if (params.redisClient && params.redisClient.status === "ready") {
    const cachePayload = {
      session: {
        id: session.id,
        userId: user.id,
        expiresAt: expiresAt.toISOString(),
        revokedAt: null,
      },
      user: {
        id: user.id,
        tenantId: user.tenantId,
        email: user.email,
        name: user.name,
        role: user.role as UserRole,
        status: user.status,
      },
    };
    await params.redisClient
      .set(`session:${tokenHash}`, JSON.stringify(cachePayload), "EX", 60)
      .catch(() => {});
  }

  recordAuthLogin("success");

  return {
    rawToken,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role as UserRole,
      tenantId: user.tenantId,
      status: user.status,
    },
  };
}

export interface LogoutParams {
  db: Database;
  repos: Repositories;
  redisClient: Redis | null;
  sessionToken?: string;
}

export async function logoutUser(params: LogoutParams): Promise<void> {
  if (!params.sessionToken) {
    return;
  }

  const tokenHash = sha256(params.sessionToken);

  // 1. Revoke session in Postgres
  await params.repos.revokeSessionByTokenHash(
    { db: params.db },
    { tokenHash },
  );

  // 2. Invalidate cache in Redis
  if (params.redisClient && params.redisClient.status === "ready") {
    await params.redisClient.del(`session:${tokenHash}`).catch(() => {});
  }
}

export interface GetMeParams {
  db: Database;
  repos: Repositories;
  auth: RequestAuth;
}

export async function getCurrentUser(
  params: GetMeParams,
): Promise<{ user: AuthUserSummary; auth: RequestAuth }> {
  if (params.auth.kind === "session" && params.auth.userId) {
    const user = await params.repos.findUserByIdGlobal(
      { db: params.db },
      { userId: params.auth.userId },
    );

    if (!user) {
      throw new NotFoundError("Authenticated user record not found");
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role as UserRole,
        tenantId: user.tenantId,
        status: user.status,
      },
      auth: params.auth,
    };
  }

  // Machine client (API key)
  return {
    user: {
      id: "api-key",
      email: "machine@internal.api",
      name: "API Key Machine Principal",
      role: params.auth.role,
      tenantId: params.auth.tenantId,
      status: "ACTIVE",
    },
    auth: params.auth,
  };
}
