import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { ValidationError } from "../../lib/errors";
import { rateLimitFor } from "../../plugins/rate-limit-policy";
import { AiDecideService } from "./decide.service";
import { decisionGovernanceRoutes } from "./governance/routes";

const decideBodySchema = z.object({
  case_id: z.string().uuid(),
  risk_id: z.string().uuid().optional(),
  purpose: z.enum(["CASE_OPENING", "REPLAN"]).default("CASE_OPENING"),
});

/**
 * AI Decision Service Fastify Routes (Spec 01 §10, Spec 03 §5, Step 14 & 15).
 * Provides internal controlled LLM decisioning behind POST /ai/decide
 * and decision audit / governance APIs behind GET /ai/decisions and GET /ai/decisions/:id.
 */
export const aiRoutes: FastifyPluginAsync = async (app) => {
  // Register decision governance read routes (GET /decisions, GET /decisions/:id)
  await app.register(decisionGovernanceRoutes);

  /**
   * POST /ai/decide — Run controlled LLM decision pipeline for a recovery case.
   *
   * Auth mapping via requireScope("ai:decide") (see plugins/rbac.ts):
   * - session callers: role must be ADMIN or OPERATIONS (scope guard falls back
   *   to role check for non-api_key auth);
   * - machine callers (incl. worker principals): api key must carry the
   *   "ai:decide" scope or the "*" wildcard.
   * Covered by the RBAC integration test (ai-decision.test.ts case 6: VIEWER → 403).
   */
  app.post(
    "/decide",
    {
      preHandler: [
        app.requireAuth,
        app.requireScope("ai:decide"),
      ],
      config: {
        // LLM calls cost money per token: budget like other expensive
        // authenticated ingestion surfaces (s-30 events class).
        rateLimit: rateLimitFor("events"),
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = decideBodySchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new ValidationError("Invalid request body for AI decisioning", {
          issues: parseResult.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const { case_id, risk_id, purpose } = parseResult.data;
      const idempotencyKey =
        (request.headers["idempotency-key"] as string | undefined)?.trim() ||
        undefined;

      const decision = await AiDecideService.decide({
        tenantId: tenantScope.tenantId,
        caseId: case_id,
        riskId: risk_id,
        purpose,
        idempotencyKey,
        db: app.db,
        repos: app.repos,
        redis: (app as any).redisClient,
        config: app.config,
      });

      return reply.status(200).send(decision);
    },
  );
};
