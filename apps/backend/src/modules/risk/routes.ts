import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  RISK_BANDS,
  RISK_STATUSES,
  RISK_TYPES,
} from "@repo/domain";
import {
  ValidationError,
  NotFoundError,
} from "../../lib/errors";

const listRisksQuerySchema = z.object({
  status: z.enum(RISK_STATUSES).optional(),
  band: z.enum(RISK_BANDS).optional(),
  risk_type: z.enum(RISK_TYPES).optional(),
  customer_id: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

const riskParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Fastify routes for Risk Engine (Spec 01 §8, s-12 §API Contracts).
 * Provides tenant-isolated read endpoints for dashboard and explainability.
 */
export const riskRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /risks — Filtered list of risk evaluations with cursor pagination
   */
  app.get(
    "",
    {
      preHandler: [app.requireAuth],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = listRisksQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new ValidationError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const query = parseResult.data;

      const result = await app.repos.listRisks(
        { db: app.db },
        {
          tenantId: tenantScope.tenantId,
          status: query.status,
          band: query.band,
          riskType: query.risk_type,
          customerId: query.customer_id,
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
          limit: query.limit,
          cursor: query.cursor,
        },
      );

      return reply.status(200).send({
        items: result.items,
        nextCursor: result.nextCursor,
      });
    },
  );

  /**
   * GET /risks/:id — Full risk evaluation with factor explainability
   */
  app.get(
    "/:id",
    {
      preHandler: [app.requireAuth],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = riskParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid risk ID format", {
          issues: parseParams.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const { id } = parseParams.data;

      const risk = await app.repos.findRevenueRiskById(
        { db: app.db },
        {
          tenantId: tenantScope.tenantId,
          riskId: id,
        },
      );

      if (!risk) {
        throw new NotFoundError("Risk evaluation not found");
      }

      return reply.status(200).send(risk);
    },
  );
};
