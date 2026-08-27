import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import fastifyCookie from "@fastify/cookie";
import type { UserRole } from "@repo/domain";
import { sha256 } from "../lib/crypto";
import {
  UnauthenticatedError,
  TenantContextMissingError,
} from "../lib/errors";
import { recordAuthFailure } from "@repo/observability";

import type Redis from "ioredis";

export interface RequestAuth {
  kind: "session" | "api_key" | "webhook";
  userId?: string;
  tenantId: string;
  role: UserRole;
  scopes?: string[];
}

declare module "fastify" {
  interface FastifyRequest {
    auth: RequestAuth | null;
  }
  interface FastifyInstance {
    redisClient: Redis | null;
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    getTenantScope: (request: FastifyRequest) => { tenantId: string };
  }
}

/**
 * Tenant guard helper function.
 * Extracts the verified tenantId from request.auth or throws TENANT_CONTEXT_MISSING.
 */
export function getTenantScope(request: FastifyRequest): { tenantId: string } {
  if (!request.auth || !request.auth.tenantId) {
    throw new TenantContextMissingError();
  }
  return { tenantId: request.auth.tenantId };
}

/**
 * requireAuth pre-handler hook.
 * Throws UnauthenticatedError (401) if request.auth is not present.
 */
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.auth) {
    recordAuthFailure("unauthenticated");
    throw new UnauthenticatedError("Authentication required");
  }
}

export interface AuthPluginOptions {
  sessionSecret?: string;
}

const authPluginCallback: FastifyPluginAsync<AuthPluginOptions> = async (
  fastify,
  opts,
) => {
  // 1. Register Fastify Cookie plugin
  await fastify.register(fastifyCookie, {
    secret: opts.sessionSecret ?? "arr-default-session-cookie-secret-min-32-chars",
    hook: "onRequest",
  });

  // 2. Decorate request and fastify instance
  fastify.decorateRequest("auth", null);
  fastify.decorate("requireAuth", requireAuth);
  fastify.decorate("getTenantScope", getTenantScope);

  // 3. Global onRequest hook to resolve principal (bearer token or session cookie)
  fastify.addHook("onRequest", async (request: FastifyRequest) => {
    request.auth = null;

    const authHeader = request.headers.authorization;
    const sessionCookie = request.cookies["rr_session"];
    const redis = fastify.redisClient;

    // A. Machine Bearer API Key Authentication (rrk_...)
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      if (token.startsWith("rrk_")) {
        const keyHash = sha256(token);
        let apiKeyData: { id: string; tenantId: string; scopes: string[]; revokedAt: string | null } | null = null;

        // Try Redis Cache (60s TTL)
        if (redis && redis.status === "ready") {
          try {
            const cached = await redis.get(`apikey:${keyHash}`);
            if (cached) {
              apiKeyData = JSON.parse(cached);
            }
          } catch {
            // cache read failure, fall back to DB
          }
        }

        // Database lookup
        if (!apiKeyData) {
          try {
            const row = await fastify.repos.findApiKeyByHash(
              { db: fastify.db },
              { keyHash },
            );
            if (row) {
              apiKeyData = {
                id: row.id,
                tenantId: row.tenantId,
                scopes: row.scopes,
                revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
              };
              if (redis && redis.status === "ready") {
                await redis.set(`apikey:${keyHash}`, JSON.stringify(apiKeyData), "EX", 60).catch(() => {});
              }
            }
          } catch (err: any) {
            request.log.error({ err: err.message }, "Failed to lookup API key from database");
          }
        }

        // Validate Key
        if (apiKeyData && !apiKeyData.revokedAt) {
          // Asynchronously touch last_used_at
          fastify.repos
            .updateApiKeyLastUsed({ db: fastify.db }, { id: apiKeyData.id })
            .catch((err: any) => {
              request.log.warn({ err: err.message }, "Failed to update API key lastUsedAt");
            });

          request.auth = {
            kind: "api_key",
            tenantId: apiKeyData.tenantId,
            role: "ADMIN", // Machine keys hold ADMIN authority within tenant
            scopes: apiKeyData.scopes,
          };
          return;
        } else if (apiKeyData?.revokedAt) {
          recordAuthFailure("revoked_key");
        } else {
          recordAuthFailure("invalid_key");
        }
      }
    }

    // B. Interactive Dashboard Session Cookie Authentication (rr_session)
    if (sessionCookie) {
      const tokenHash = sha256(sessionCookie);
      let sessionUser: {
        session: { id: string; userId: string; expiresAt: string; revokedAt: string | null };
        user: { id: string; tenantId: string; email: string; name: string; role: UserRole; status: string };
      } | null = null;

      // Try Redis Cache (60s TTL)
      if (redis && redis.status === "ready") {
        try {
          const cached = await redis.get(`session:${tokenHash}`);
          if (cached) {
            sessionUser = JSON.parse(cached);
          }
        } catch {
          // cache read failure, fall back to DB
        }
      }

      // Database lookup
      if (!sessionUser) {
        try {
          const row = await fastify.repos.findSessionByTokenHash(
            { db: fastify.db },
            { tokenHash },
          );
          if (row) {
            sessionUser = {
              session: {
                id: row.session.id,
                userId: row.session.userId,
                expiresAt: row.session.expiresAt.toISOString(),
                revokedAt: row.session.revokedAt ? row.session.revokedAt.toISOString() : null,
              },
              user: {
                id: row.user.id,
                tenantId: row.user.tenantId,
                email: row.user.email,
                name: row.user.name,
                role: row.user.role as UserRole,
                status: row.user.status,
              },
            };
            if (redis && redis.status === "ready") {
              await redis.set(`session:${tokenHash}`, JSON.stringify(sessionUser), "EX", 60).catch(() => {});
            }
          }
        } catch (err: any) {
          request.log.error({ err: err.message }, "Failed to lookup session from database");
        }
      }

      // Validate session and user status
      if (sessionUser && !sessionUser.session.revokedAt) {
        const expiresAt = new Date(sessionUser.session.expiresAt);
        const now = new Date();

        if (expiresAt > now) {
          // Verify user is ACTIVE
          if (sessionUser.user.status === "ACTIVE") {
            request.auth = {
              kind: "session",
              userId: sessionUser.user.id,
              tenantId: sessionUser.user.tenantId,
              role: sessionUser.user.role,
            };

            // Sliding renewal: if remaining TTL is less than 6 hours, extend to 12h
            const remainingMs = expiresAt.getTime() - now.getTime();
            const sixHoursMs = 6 * 60 * 60 * 1000;
            if (remainingMs < sixHoursMs) {
              const newExpiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000);
              fastify.repos
                .updateSessionExpiry(
                  { db: fastify.db },
                  { id: sessionUser.session.id, expiresAt: newExpiresAt },
                )
                .then(() => {
                  if (redis && redis.status === "ready" && sessionUser) {
                    sessionUser.session.expiresAt = newExpiresAt.toISOString();
                    return redis.set(`session:${tokenHash}`, JSON.stringify(sessionUser), "EX", 60);
                  }
                })
                .catch(() => {});
            }

            return;
          } else {
            recordAuthFailure("disabled_user");
          }
        } else {
          recordAuthFailure("expired_session");
        }
      } else if (sessionUser?.session.revokedAt) {
        recordAuthFailure("revoked_session");
      }
    }
  });
};

export const authPlugin = fp(authPluginCallback, {
  name: "app-auth",
  fastify: "5.x",
  dependencies: ["app-db"],
});
