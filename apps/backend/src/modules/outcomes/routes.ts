import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { RISK_TYPES } from "@repo/domain";
import { ValidationError, NotFoundError, NoOutcomeError } from "../../lib/errors";
import { rateLimitFor } from "../../plugins/rate-limit-policy";

const listOutcomesQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  to: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  surface: z.enum(RISK_TYPES).optional(),
  method: z.string().min(1).optional(),
  customer_id: z.string().uuid().optional(),
  limit: z.coerce.number().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

const caseParamSchema = z.object({
  id: z.string().uuid(),
});

export function toOutcomeResponse(row: any) {
  const recoveredAmount = BigInt(row.recoveredAmount ?? 0);
  const recoveryCost = BigInt(row.recoveryCost ?? 0);
  const netRecovered =
    row.netRecovered !== null && row.netRecovered !== undefined
      ? BigInt(row.netRecovered)
      : recoveredAmount - recoveryCost;

  return {
    id: row.id,
    tenant_id: row.tenantId,
    case_id: row.caseId,
    payment_id: row.paymentId,
    baseline_amount: row.baselineAmount.toString(),
    recovered_amount: recoveredAmount.toString(),
    recovery_cost: recoveryCost.toString(),
    net_recovered: netRecovered.toString(),
    attribution_method: row.attributionMethod,
    attribution_window_hours: row.attributionWindowHours,
    recovered_at:
      row.recoveredAt instanceof Date
        ? row.recoveredAt.toISOString()
        : row.recoveredAt,
    recorded_at:
      row.recordedAt instanceof Date
        ? row.recordedAt.toISOString()
        : row.recordedAt,
    created_at:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : row.createdAt,
    updated_at:
      row.updatedAt instanceof Date
        ? row.updatedAt.toISOString()
        : row.updatedAt,
    case_number: row.caseNumber ?? undefined,
    risk_type: row.riskType ?? undefined,
    customer_id: row.customerId ?? undefined,
  };
}

/**
 * Fastify routes for Outcomes & Attribution Economics (Spec 01 §25, Spec 02 §8/§9, Step 26).
 */
export const outcomesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /outcomes — Authoritative recovery outcome records with SQL aggregate summaries & cursor pagination (VIEWER+)
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
      const parseResult = listOutcomesQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new ValidationError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const query = parseResult.data;

      const result = await app.repos.listOutcomesWithAggregates(
        { db: app.db },
        {
          tenantId: tenantScope.tenantId,
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
          surface: query.surface,
          method: query.method,
          customerId: query.customer_id,
          limit: query.limit,
          cursor: query.cursor,
        },
      );

      const items = result.items.map(toOutcomeResponse);

      return reply.status(200).send({
        items,
        aggregates: {
          recovered_minor: result.aggregates.recovered_minor.toString(),
          cost_minor: result.aggregates.cost_minor.toString(),
          net_minor: result.aggregates.net_minor.toString(),
          count: result.aggregates.count,
        },
        next_cursor: result.nextCursor,
      });
    },
  );

  /**
   * GET /outcomes/cases/:id — Lookup outcome for specific case ID.
   *
   * Compatibility alias: the canonical path is GET /cases/:id/outcome
   * (apps/backend/src/modules/cases/routes.ts), which additionally verifies
   * case existence per tenant before outcome lookup. This alias is kept (do NOT
   * delete) to avoid breaking existing clients; prefer the canonical path for
   * new integrations. Both return 404 when tenant-scoped outcome is absent
   * (alias surfaces NO_OUTCOME; canonical distinguishes NOT_FOUND vs NO_OUTCOME).
   */
  app.get(
    "/cases/:id",
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
      const parseParams = caseParamSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid case ID format", {
          issues: parseParams.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const { id } = parseParams.data;

      const outcome = await app.repos.findOutcomeByCaseId(
        { db: app.db },
        { tenantId: tenantScope.tenantId, caseId: id },
      );

      if (!outcome) {
        throw new NoOutcomeError();
      }

      return reply.status(200).send(toOutcomeResponse(outcome));
    },
  );
};
