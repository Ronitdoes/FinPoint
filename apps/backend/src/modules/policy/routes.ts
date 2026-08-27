import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { ActorType } from "@repo/domain";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "../../lib/errors";
import {
  CreatePolicyRuleSchema,
  EvaluatePolicyRequestSchema,
  UpdatePolicyRuleSchema,
} from "./policy.types";
import { PolicyService } from "./policy.service";

/**
 * Pre-handler checking that caller is either a worker principal with 'policy:evaluate' / '*' scope,
 * or a session user with role >= OPERATIONS (OPERATIONS, FINANCE, ADMIN).
 */
async function requirePolicyEvaluateAuth(request: FastifyRequest, _reply: FastifyReply) {
  if (!request.auth) {
    throw new UnauthenticatedError("Authentication required");
  }

  if (request.auth.kind === "api_key") {
    const scopes = request.auth.scopes ?? [];
    const hasScope = scopes.includes("*") || scopes.includes("policy:evaluate") || scopes.includes("worker");
    if (!hasScope) {
      throw new ForbiddenError("API key missing required 'policy:evaluate' scope");
    }
  } else {
    // Session principal: role >= OPERATIONS (OPERATIONS, FINANCE, ADMIN)
    const role = request.auth.role;
    if (!["ADMIN", "FINANCE", "OPERATIONS"].includes(role)) {
      throw new ForbiddenError(
        `Role '${role}' is not authorized to evaluate policies (OPERATIONS+ required)`,
      );
    }
  }
}

export const policyRoutes: FastifyPluginAsync = async (fastify) => {
  const policyService = new PolicyService(fastify.db, fastify.repos);

  // 1. POST /policy/evaluate — worker principal (policy:evaluate) or session role >= OPERATIONS
  fastify.post(
    "/evaluate",
    {
      preHandler: [fastify.requireAuth, requirePolicyEvaluateAuth],
    },
    async (request, reply) => {
      const tenantScope = fastify.getTenantScope(request);
      const parsedBody = EvaluatePolicyRequestSchema.safeParse(request.body);

      if (!parsedBody.success) {
        throw new ValidationError("Invalid policy evaluation request payload", parsedBody.error.issues);
      }

      const actorContext = {
        userId: request.auth?.userId,
        role: request.auth?.role,
        actorType: (request.auth?.kind === "api_key" ? "SYSTEM" : "USER") as ActorType,
      };

      const result = await policyService.evaluatePolicy(
        tenantScope.tenantId,
        parsedBody.data,
        actorContext,
      );

      return reply.status(200).send(result);
    },
  );
};

export const policiesCrudRoutes: FastifyPluginAsync = async (fastify) => {
  const policyService = new PolicyService(fastify.db, fastify.repos);

  // 2. GET /policies — role >= VIEWER
  fastify.get(
    "",
    {
      preHandler: [
        fastify.requireAuth,
        fastify.requireRole("ADMIN", "FINANCE", "OPERATIONS", "SUPPORT", "VIEWER"),
      ],
    },
    async (request, reply) => {
      const tenantScope = fastify.getTenantScope(request);
      const policies = await policyService.listPolicies(tenantScope.tenantId);
      return reply.status(200).send({ policies });
    },
  );

  // 3. POST /policies — role >= FINANCE (FINANCE, ADMIN)
  fastify.post(
    "",
    {
      preHandler: [fastify.requireAuth, fastify.requireRole("ADMIN", "FINANCE")],
    },
    async (request, reply) => {
      const tenantScope = fastify.getTenantScope(request);
      const parsed = CreatePolicyRuleSchema.safeParse(request.body);

      if (!parsed.success) {
        throw new ValidationError("Invalid policy rule creation payload", parsed.error.issues);
      }

      const actorContext = {
        userId: request.auth?.userId,
        role: request.auth?.role,
        actorType: (request.auth?.kind === "api_key" ? "SYSTEM" : "USER") as ActorType,
      };

      const created = await policyService.createPolicyRule(
        tenantScope.tenantId,
        parsed.data,
        actorContext,
      );

      return reply.status(201).send(created);
    },
  );

  // 4. PATCH /policies/:id — role >= FINANCE (FINANCE, ADMIN)
  fastify.patch<{ Params: { id: string } }>(
    "/:id",
    {
      preHandler: [fastify.requireAuth, fastify.requireRole("ADMIN", "FINANCE")],
    },
    async (request, reply) => {
      const tenantScope = fastify.getTenantScope(request);
      const { id } = request.params;

      const parsed = UpdatePolicyRuleSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid policy rule update payload", parsed.error.issues);
      }

      const actorContext = {
        userId: request.auth?.userId,
        role: request.auth?.role,
        actorType: (request.auth?.kind === "api_key" ? "SYSTEM" : "USER") as ActorType,
      };

      const updated = await policyService.updatePolicyRule(
        tenantScope.tenantId,
        id,
        parsed.data,
        actorContext,
      );

      return reply.status(200).send(updated);
    },
  );

  // 5. GET /policies/:id/versions — role >= FINANCE (FINANCE, ADMIN)
  fastify.get<{ Params: { id: string } }>(
    "/:id/versions",
    {
      preHandler: [fastify.requireAuth, fastify.requireRole("ADMIN", "FINANCE")],
    },
    async (request, reply) => {
      const tenantScope = fastify.getTenantScope(request);
      const { id } = request.params;

      const versions = await policyService.listPolicyVersions(
        tenantScope.tenantId,
        id,
      );

      return reply.status(200).send({ versions });
    },
  );
};
