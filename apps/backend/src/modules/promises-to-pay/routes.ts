import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { ValidationError } from "../../lib/errors";
import { PromisesToPayService } from "./service";
import {
  listPromisesToPayQuerySchema,
  markPromiseHonoredBodySchema,
  promiseToPayParamsSchema,
} from "./types";

/**
 * Fastify routes for Promise-to-Pay tracking and manual reconciliation (Spec 24).
 */
export const promisesToPayRoutes: FastifyPluginAsync = async (app) => {
  const service = new PromisesToPayService(app.db, app.repos);

  /**
   * GET /promises-to-pay?status=&customer_id= (VIEWER+)
   */
  app.get(
    "",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("VIEWER", "SUPPORT", "OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = listPromisesToPayQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new ValidationError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const result = await service.listPromises(
        tenantScope.tenantId,
        parseResult.data,
      );

      return reply.status(200).send(result);
    },
  );

  /**
   * GET /promises-to-pay/:id (VIEWER+)
   */
  app.get(
    "/:id",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("VIEWER", "SUPPORT", "OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = promiseToPayParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid promise ID format", {
          issues: parseParams.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const ptp = await service.getPromiseById(
        tenantScope.tenantId,
        parseParams.data.id,
      );

      return reply.status(200).send(ptp);
    },
  );

  /**
   * POST /promises-to-pay/:id/mark-honored (FINANCE+)
   */
  app.post(
    "/:id/mark-honored",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = promiseToPayParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid promise ID format", {
          issues: parseParams.error.issues,
        });
      }

      const parseBody = markPromiseHonoredBodySchema.safeParse(request.body);
      if (!parseBody.success) {
        throw new ValidationError("Invalid mark-honored payload", {
          issues: parseBody.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const actorId = request.auth?.userId;

      const updated = await service.markHonored(
        tenantScope.tenantId,
        parseParams.data.id,
        parseBody.data,
        actorId,
      );

      return reply.status(200).send({ promise: updated, success: true });
    },
  );
};
