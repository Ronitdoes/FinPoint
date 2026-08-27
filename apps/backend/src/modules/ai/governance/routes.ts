import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { DECISION_STATUSES } from "@repo/domain";
import { ValidationError, NotFoundError } from "../../../lib/errors";

const listDecisionsQuerySchema = z.object({
  case_id: z.string().uuid().optional(),
  status: z.enum(DECISION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  include: z.string().optional(),
});

const getDecisionParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * AI Decision Governance & Audit Read Routes (Spec 01 §10, Step 15 §2).
 * Exposes role-gated access (OPERATIONS+) to immutable AI decision records and ledger entries.
 */
export const decisionGovernanceRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /decisions — List AI decision records for tenant with case/status filters.
   * Role: >= OPERATIONS
   * Query params: case_id, status, limit, offset, include=input_snapshot (ADMIN only)
   */
  app.get(
    "/decisions",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseQuery = listDecisionsQuerySchema.safeParse(request.query);
      if (!parseQuery.success) {
        throw new ValidationError("Invalid decision query parameters", {
          issues: parseQuery.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const { case_id, status, limit, offset, include } = parseQuery.data;
      const isAdmin = request.auth?.role === "ADMIN";
      const includeSnapshot = isAdmin && include === "input_snapshot";

      const rows = await app.repos.listDecisions(
        { db: app.db },
        {
          tenantId: tenantScope.tenantId,
          caseId: case_id,
          status,
          limit,
          offset,
        },
      );

      const items = rows.map((decision) => {
        const base = {
          id: decision.id,
          tenantId: decision.tenantId,
          caseId: decision.caseId,
          model: decision.model,
          modelVersion: decision.modelVersion,
          promptVersion: decision.promptVersion,
          diagnosisCause: decision.diagnosisCause,
          diagnosisConfidence: decision.diagnosisConfidence ? Number(decision.diagnosisConfidence) : null,
          recommendedActions: decision.recommendedActions,
          stopConditions: decision.stopConditions,
          status: decision.status,
          latencyMs: decision.latencyMs,
          inputTokens: decision.inputTokens,
          outputTokens: decision.outputTokens,
          costMinorUnits: Number(decision.costMinorUnits ?? 0n),
          error: decision.error,
          createdAt: decision.createdAt,
        };

        if (includeSnapshot) {
          return {
            ...base,
            inputSnapshot: decision.inputSnapshot,
            outputRaw: decision.outputRaw,
          };
        }

        return base;
      });

      return reply.status(200).send({
        items,
        count: items.length,
        limit,
        offset,
      });
    },
  );

  /**
   * GET /decisions/:id — Retrieve a single AI decision record by ID.
   * Role: >= OPERATIONS
   */
  app.get(
    "/decisions/:id",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = getDecisionParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid decision ID format", {
          issues: parseParams.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const decision = await app.repos.findDecisionById(
        { db: app.db },
        {
          tenantId: tenantScope.tenantId,
          decisionId: parseParams.data.id,
        },
      );

      if (!decision) {
        throw new NotFoundError("AI decision record not found", {
          decisionId: parseParams.data.id,
        });
      }

      return reply.status(200).send({
        ...decision,
        diagnosisConfidence: decision.diagnosisConfidence
          ? Number(decision.diagnosisConfidence)
          : null,
        costMinorUnits: Number(decision.costMinorUnits ?? 0n),
      });
    },
  );
};
