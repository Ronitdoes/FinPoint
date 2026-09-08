import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { ACTOR_TYPES } from "@repo/domain";
import { ValidationError } from "../../lib/errors";
import { rateLimitFor } from "../../plugins/rate-limit-policy";

const auditQuerySchema = z.object({
  case_id: z.string().uuid().optional(),
  actor_type: z.enum(ACTOR_TYPES).optional(),
  event: z.string().optional(),
  from: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

/**
 * Compliance Audit Routes (Spec 01 §18, Spec 03 §11, Step 25).
 * Strictly ADMIN-only compliance inspection endpoint.
 */
export const auditRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /audit — Query compliance audit trail logs with cursor pagination (ADMIN only)
   */
  app.get(
    "",
    {
      preHandler: [app.requireAuth, app.requireRole("ADMIN")],
      config: {
        rateLimit: rateLimitFor("read"),
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = auditQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new ValidationError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const query = parseResult.data;

      const result = await app.repos.listAuditLogsWithCursor(
        { db: app.db },
        {
          tenantId: tenantScope.tenantId,
          caseId: query.case_id,
          actorType: query.actor_type,
          event: query.event,
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
};
