import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { ValidationError } from "../../lib/errors";
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
   * Internal endpoint: requires session role >= OPERATIONS or API key with 'ai:decide' scope.
   */
  app.post(
    "/decide",
    {
      preHandler: [
        app.requireAuth,
        app.requireScope("ai:decide"),
      ],
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
