import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  CASE_STATUSES,
  RISK_TYPES,
} from "@repo/domain";
import {
  ValidationError,
  NotFoundError,
} from "../../lib/errors";
import { CaseControlService } from "./control.service";
import { toCanonicalCaseDetail, toCaseSummary } from "./case-mapper";

const listCasesQuerySchema = z.object({
  status: z.enum(CASE_STATUSES).optional(),
  risk_type: z.enum(RISK_TYPES).optional(),
  customer_id: z.string().uuid().optional(),
  min_amount: z.coerce.number().min(0).optional(),
  opened_from: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  opened_to: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

const caseParamsSchema = z.object({
  id: z.string().uuid(),
});

const escalateBodySchema = z.object({
  notes: z.string().optional(),
});

const stopBodySchema = z.object({
  reason: z.string().min(1, "reason is mandatory to stop case"),
});

/**
 * Fastify routes for Recovery Cases (Spec 02 §13, Step 17).
 */
export const caseRoutes: FastifyPluginAsync = async (app) => {
  const controlService = new CaseControlService(app.db, app.repos);

  /**
   * GET /cases — Filtered list of recovery cases with cursor pagination (VIEWER+)
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
      const parseResult = listCasesQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new ValidationError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const query = parseResult.data;

      const result = await app.repos.listCasesWithCursor(
        { db: app.db },
        {
          tenantId: tenantScope.tenantId,
          status: query.status,
          riskType: query.risk_type,
          customerId: query.customer_id,
          minAmount: query.min_amount,
          openedFrom: query.opened_from ? new Date(query.opened_from) : undefined,
          openedTo: query.opened_to ? new Date(query.opened_to) : undefined,
          limit: query.limit,
          cursor: query.cursor,
        },
      );

      const items = result.items.map(toCaseSummary);

      return reply.status(200).send({
        items,
        nextCursor: result.nextCursor,
      });
    },
  );

  /**
   * GET /cases/:id — Canonical recovery case detail with embedded relations (VIEWER+)
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
      const parseParams = caseParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid case ID format", {
          issues: parseParams.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const { id } = parseParams.data;

      const caseRow = await app.repos.findCaseById(
        { db: app.db },
        { tenantId: tenantScope.tenantId, caseId: id },
      );

      if (!caseRow) {
        throw new NotFoundError("Recovery case not found");
      }

      // Fetch related records in parallel
      const [risk, decision, policyEvaluation, actions, workflow, outcome] =
        await Promise.all([
          caseRow.riskId
            ? app.repos.findRevenueRiskById(
                { db: app.db },
                { tenantId: tenantScope.tenantId, riskId: caseRow.riskId },
              )
            : Promise.resolve(null),
          app.repos.findLatestDecisionForCase(
            { db: app.db },
            { tenantId: tenantScope.tenantId, caseId: id },
          ),
          app.repos.findLatestPolicyEvaluationForCase(
            { db: app.db },
            { tenantId: tenantScope.tenantId, caseId: id },
          ),
          app.repos.listActionsForCase(
            { db: app.db },
            { tenantId: tenantScope.tenantId, caseId: id },
          ),
          app.repos.findWorkflowByCaseId(
            { db: app.db },
            { tenantId: tenantScope.tenantId, caseId: id },
          ),
          app.repos.findOutcomeByCaseId(
            { db: app.db },
            { tenantId: tenantScope.tenantId, caseId: id },
          ),
        ]);

      const canonicalDetail = toCanonicalCaseDetail(caseRow, {
        risk,
        decision,
        policyEvaluation,
        actions,
        workflow,
        outcome,
      });

      return reply.status(200).send(canonicalDetail);
    },
  );

  /**
   * GET /cases/:id/timeline — Chronological timeline of case events (VIEWER+)
   */
  app.get(
    "/:id/timeline",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("VIEWER", "SUPPORT", "OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = caseParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid case ID format", {
          issues: parseParams.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const { id } = parseParams.data;

      const caseRow = await app.repos.findCaseById(
        { db: app.db },
        { tenantId: tenantScope.tenantId, caseId: id },
      );

      if (!caseRow) {
        throw new NotFoundError("Recovery case not found");
      }

      const events = await app.repos.listCaseEvents(
        { db: app.db },
        { tenantId: tenantScope.tenantId, caseId: id, limit: 100 },
      );

      return reply.status(200).send({ items: events });
    },
  );

  /**
   * POST /cases/:id/pause — Pauses an in-progress recovery case (OPERATIONS+)
   */
  app.post(
    "/:id/pause",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = caseParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid case ID format", {
          issues: parseParams.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const { id } = parseParams.data;

      const result = await controlService.pauseCase(
        tenantScope.tenantId,
        id,
        {
          userId: request.auth?.userId,
          role: request.auth?.role,
          actorType: "USER",
        },
      );

      return reply.status(202).send(result);
    },
  );

  /**
   * POST /cases/:id/resume — Resumes a paused recovery case (OPERATIONS+)
   */
  app.post(
    "/:id/resume",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = caseParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid case ID format", {
          issues: parseParams.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const { id } = parseParams.data;

      const result = await controlService.resumeCase(
        tenantScope.tenantId,
        id,
        {
          userId: request.auth?.userId,
          role: request.auth?.role,
          actorType: "USER",
        },
      );

      return reply.status(202).send(result);
    },
  );

  /**
   * POST /cases/:id/escalate — Escalates case and creates human task (SUPPORT+)
   */
  app.post(
    "/:id/escalate",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("SUPPORT", "OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = caseParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid case ID format", {
          issues: parseParams.error.issues,
        });
      }

      const parseBody = escalateBodySchema.safeParse(request.body ?? {});
      if (!parseBody.success) {
        throw new ValidationError("Invalid escalate payload", {
          issues: parseBody.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const { id } = parseParams.data;

      const result = await controlService.escalateCase(
        tenantScope.tenantId,
        id,
        {
          userId: request.auth?.userId,
          role: request.auth?.role,
          actorType: "USER",
        },
        parseBody.data.notes,
      );

      return reply.status(202).send(result);
    },
  );

  /**
   * POST /cases/:id/stop — Stops case with mandatory reason (FINANCE+)
   */
  app.post(
    "/:id/stop",
    {
      preHandler: [app.requireAuth, app.requireRole("FINANCE", "ADMIN")],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = caseParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid case ID format", {
          issues: parseParams.error.issues,
        });
      }

      const parseBody = stopBodySchema.safeParse(request.body ?? {});
      if (!parseBody.success) {
        throw new ValidationError("Invalid stop payload: reason is required", {
          issues: parseBody.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const { id } = parseParams.data;

      const result = await controlService.stopCase(
        tenantScope.tenantId,
        id,
        parseBody.data.reason,
        {
          userId: request.auth?.userId,
          role: request.auth?.role,
          actorType: "USER",
        },
      );

      return reply.status(202).send(result);
    },
  );
};
