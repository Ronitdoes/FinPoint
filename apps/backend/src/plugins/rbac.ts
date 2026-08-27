import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import type { UserRole } from "@repo/domain";
import { ForbiddenError, UnauthenticatedError } from "../lib/errors";
import { recordAuthFailure } from "@repo/observability";

export type RoleGuard = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

export type ScopeGuard = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    requireRole: (...allowedRoles: UserRole[]) => RoleGuard;
    requireScope: (...requiredScopes: string[]) => ScopeGuard;
  }
}

/**
 * Factory for creating RBAC role-checking pre-handlers.
 * Enforces strict role containment per Spec 01 §22 and ADR-012.
 */
export function requireRole(...allowedRoles: UserRole[]): RoleGuard {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.auth) {
      recordAuthFailure("unauthenticated");
      throw new UnauthenticatedError("Authentication required");
    }

    if (!allowedRoles.includes(request.auth.role)) {
      recordAuthFailure("forbidden_role");
      throw new ForbiddenError(
        `Forbidden: Role '${request.auth.role}' is not authorized for this operation`,
      );
    }
  };
}

/**
 * Factory for creating API Key scope-checking pre-handlers (s-11 §POST /events contract).
 * Supports '*' wildcard scope and session fallback for privileged roles.
 */
export function requireScope(...requiredScopes: string[]): ScopeGuard {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.auth) {
      recordAuthFailure("unauthenticated");
      throw new UnauthenticatedError("Authentication required");
    }

    if (request.auth.kind === "api_key") {
      const keyScopes = request.auth.scopes ?? [];
      const hasWildcard = keyScopes.includes("*");
      const hasAll = requiredScopes.every((scope) => keyScopes.includes(scope));
      if (!hasWildcard && !hasAll) {
        recordAuthFailure("forbidden_scope");
        throw new ForbiddenError(
          `Forbidden: API key missing required scope(s): ${requiredScopes.join(", ")}`,
        );
      }
    } else {
      if (!["ADMIN", "OPERATIONS"].includes(request.auth.role)) {
        recordAuthFailure("forbidden_role");
        throw new ForbiddenError(
          `Forbidden: Role '${request.auth.role}' is not authorized for this operation`,
        );
      }
    }
  };
}

const rbacPluginCallback: FastifyPluginAsync = async (fastify) => {
  fastify.decorate("requireRole", requireRole);
  fastify.decorate("requireScope", requireScope);
};

export const rbacPlugin = fp(rbacPluginCallback, {
  name: "app-rbac",
  fastify: "5.x",
  dependencies: ["app-auth"],
});
