import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { ForbiddenError, ValidationError } from "../../lib/errors";
import { HumanTasksService } from "./service";
import { rateLimitFor } from "../../plugins/rate-limit-policy";
import {
  approveHumanTaskBodySchema,
  assignHumanTaskBodySchema,
  cancelHumanTaskBodySchema,
  createHumanTaskBodySchema,
  humanTaskParamsSchema,
  listHumanTasksQuerySchema,
  rejectHumanTaskBodySchema,
  type HumanTaskActorContext,
} from "./types";

/**
 * Fastify routes for Human-in-the-Loop Escalation and Approvals (Spec 01 §19, Step 21).
 */
export const humanTasksRoutes: FastifyPluginAsync = async (app) => {
  const service = new HumanTasksService(app.db, app.repos);

  function extractActor(request: FastifyRequest): HumanTaskActorContext {
    return {
      userId: request.auth?.userId,
      role: request.auth?.role ?? "VIEWER",
      actorType: request.auth?.kind === "session" ? "USER" : "SYSTEM",
    };
  }

  /**
   * GET /human-tasks — Filtered list of human escalation tasks (VIEWER+)
   */
  app.get(
    "",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("VIEWER", "SUPPORT", "OPERATIONS", "FINANCE", "ADMIN"),
      ],
      config: {
        rateLimit: rateLimitFor("read"),
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = listHumanTasksQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new ValidationError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const result = await service.listTasks(
        tenantScope.tenantId,
        parseResult.data,
      );

      return reply.status(200).send(result);
    },
  );

  /**
   * GET /human-tasks/:id — Detailed task view with linked case & decision context (VIEWER+)
   */
  app.get(
    "/:id",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("VIEWER", "SUPPORT", "OPERATIONS", "FINANCE", "ADMIN"),
      ],
      config: {
        rateLimit: rateLimitFor("read"),
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = humanTaskParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid task ID format", {
          issues: parseParams.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const detail = await service.getTaskDetail(
        tenantScope.tenantId,
        parseParams.data.id,
      );

      return reply.status(200).send(detail);
    },
  );

  /**
   * POST /human-tasks — Manual task creation (OPERATIONS+)
   */
  app.post(
    "",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseBody = createHumanTaskBodySchema.safeParse(request.body);
      if (!parseBody.success) {
        throw new ValidationError("Invalid task creation payload", {
          issues: parseBody.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const actor = extractActor(request);

      const created = await service.createTask(
        tenantScope.tenantId,
        parseBody.data,
        actor,
      );

      return reply.status(201).send(created);
    },
  );

  /**
   * POST /human-tasks/:id/approve — Approves a task (OPERATIONS+, interactive session user only)
   */
  app.post(
    "/:id/approve",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Enforce interactive session user for audit accountability (ADR-012, Step 21)
      if (request.auth?.kind !== "session" || !request.auth?.userId) {
        throw new ForbiddenError(
          "Task approval requires an interactive user session",
        );
      }

      const parseParams = humanTaskParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid task ID format", {
          issues: parseParams.error.issues,
        });
      }

      const parseBody = approveHumanTaskBodySchema.safeParse(request.body ?? {});
      if (!parseBody.success) {
        throw new ValidationError("Invalid approve payload", {
          issues: parseBody.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const actor = extractActor(request);

      const result = await service.approveTask(
        tenantScope.tenantId,
        parseParams.data.id,
        actor,
        parseBody.data.notes,
      );

      return reply.status(200).send(result);
    },
  );

  /**
   * POST /human-tasks/:id/reject — Rejects a task with mandatory notes (OPERATIONS+, session user only)
   */
  app.post(
    "/:id/reject",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Enforce interactive session user
      if (request.auth?.kind !== "session" || !request.auth?.userId) {
        throw new ForbiddenError(
          "Task rejection requires an interactive user session",
        );
      }

      const parseParams = humanTaskParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid task ID format", {
          issues: parseParams.error.issues,
        });
      }

      const parseBody = rejectHumanTaskBodySchema.safeParse(request.body);
      if (!parseBody.success) {
        throw new ValidationError("Invalid reject payload: notes are required", {
          issues: parseBody.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const actor = extractActor(request);

      const result = await service.rejectTask(
        tenantScope.tenantId,
        parseParams.data.id,
        actor,
        parseBody.data.notes,
      );

      return reply.status(200).send(result);
    },
  );

  /**
   * POST /human-tasks/:id/assign — Assigns task to an agent (FINANCE+)
   */
  app.post(
    "/:id/assign",
    {
      preHandler: [app.requireAuth, app.requireRole("FINANCE", "ADMIN")],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = humanTaskParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid task ID format", {
          issues: parseParams.error.issues,
        });
      }

      const parseBody = assignHumanTaskBodySchema.safeParse(request.body);
      if (!parseBody.success) {
        throw new ValidationError("Invalid assign payload", {
          issues: parseBody.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const actor = extractActor(request);

      const result = await service.assignTask(
        tenantScope.tenantId,
        parseParams.data.id,
        parseBody.data.assignee_user_id ?? null,
        actor,
      );

      return reply.status(200).send(result);
    },
  );

  /**
   * POST /human-tasks/:id/cancel — Cancels a task (FINANCE+)
   */
  app.post(
    "/:id/cancel",
    {
      preHandler: [app.requireAuth, app.requireRole("FINANCE", "ADMIN")],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = humanTaskParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid task ID format", {
          issues: parseParams.error.issues,
        });
      }

      const parseBody = cancelHumanTaskBodySchema.safeParse(request.body ?? {});
      if (!parseBody.success) {
        throw new ValidationError("Invalid cancel payload", {
          issues: parseBody.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const actor = extractActor(request);

      const result = await service.cancelTask(
        tenantScope.tenantId,
        parseParams.data.id,
        parseBody.data.reason,
        actor,
      );

      return reply.status(200).send(result);
    },
  );
};
