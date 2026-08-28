import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { BadRequestError } from "../../lib/errors";
import { fetchWithAnalyticsCache } from "./cache";
import { executeSummaryQuery } from "./queries/summary";
import { executeRecoveryTimeseriesQuery } from "./queries/recovery-timeseries";
import { executeInterventionsQuery } from "./queries/interventions";
import { executeFunnelQuery } from "./queries/funnel";
import { executeRiskMixQuery } from "./queries/risk-mix";
import { executeAiPerformanceQuery } from "./queries/ai-performance";

const analyticsRangeQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const recoveryTimeseriesQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  bucket: z.enum(["day", "week"]).default("day"),
});

const MAX_RANGE_DAYS = 370;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;

/**
 * Validates and parses from/to date parameters with strict >370d rejection (Step 27 API Contracts).
 */
export function parseAndValidateDateRange(query: { from?: string; to?: string }): {
  from?: Date;
  to?: Date;
} {
  let fromDate: Date | undefined;
  let toDate: Date | undefined;

  if (query.from) {
    fromDate = new Date(query.from);
    if (isNaN(fromDate.getTime())) {
      throw new BadRequestError(`Invalid 'from' date format: ${query.from}`);
    }
  }

  if (query.to) {
    toDate = new Date(query.to);
    if (isNaN(toDate.getTime())) {
      throw new BadRequestError(`Invalid 'to' date format: ${query.to}`);
    }
  }

  if (fromDate && toDate) {
    if (fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestError("'from' date cannot be after 'to' date");
    }

    const diffMs = toDate.getTime() - fromDate.getTime();
    if (diffMs > MAX_RANGE_MS) {
      throw new BadRequestError(
        `Date range exceeds maximum allowed window of ${MAX_RANGE_DAYS} days`,
      );
    }
  }

  return { from: fromDate, to: toDate };
}

/**
 * Analytics Service REST Routes (Spec 02 §13, Spec 00 §6/§9, Spec 03 §7, Step 27).
 */
export const analyticsRoutes: FastifyPluginAsync = async (app) => {
  // Pre-handler hook: authentication and role verification (VIEWER+)
  app.addHook("preHandler", app.requireAuth);
  app.addHook(
    "preHandler",
    app.requireRole("VIEWER", "SUPPORT", "OPERATIONS", "FINANCE", "ADMIN"),
  );

  /**
   * GET /analytics/summary — Financial and operational summary cards
   */
  app.get(
    "/summary",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = analyticsRangeQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new BadRequestError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const { from, to } = parseAndValidateDateRange(parseResult.data);
      const tenantScope = app.getTenantScope(request);
      const isFinanceOrAdmin = ["FINANCE", "ADMIN"].includes(
        request.auth?.role ?? "",
      );

      if (!isFinanceOrAdmin) {
        reply.header("x-cost-data-redacted", "true");
      }

      const payload = await fetchWithAnalyticsCache(
        app.redisClient,
        tenantScope.tenantId,
        "summary",
        {
          from: from?.toISOString(),
          to: to?.toISOString(),
          isFinanceOrAdmin,
        },
        async () =>
          await executeSummaryQuery({
            db: app.db,
            repos: app.repos,
            tenantId: tenantScope.tenantId,
            from,
            to,
            isFinanceOrAdmin,
          }),
      );

      return reply.status(200).send(payload);
    },
  );

  /**
   * GET /analytics/recovery — Recovery vs at-risk revenue time series (day/week buckets)
   */
  app.get(
    "/recovery",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = recoveryTimeseriesQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new BadRequestError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const { from, to } = parseAndValidateDateRange(parseResult.data);
      const bucket = parseResult.data.bucket;
      const tenantScope = app.getTenantScope(request);
      const isFinanceOrAdmin = ["FINANCE", "ADMIN"].includes(
        request.auth?.role ?? "",
      );

      if (!isFinanceOrAdmin) {
        reply.header("x-cost-data-redacted", "true");
      }

      const payload = await fetchWithAnalyticsCache(
        app.redisClient,
        tenantScope.tenantId,
        "recovery",
        {
          from: from?.toISOString(),
          to: to?.toISOString(),
          bucket,
          isFinanceOrAdmin,
        },
        async () =>
          await executeRecoveryTimeseriesQuery({
            db: app.db,
            repos: app.repos,
            tenantId: tenantScope.tenantId,
            from,
            to,
            bucket,
            isFinanceOrAdmin,
          }),
      );

      return reply.status(200).send(payload);
    },
  );

  /**
   * GET /analytics/interventions — Performance breakdown per recovery action type
   */
  app.get(
    "/interventions",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = analyticsRangeQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new BadRequestError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const { from, to } = parseAndValidateDateRange(parseResult.data);
      const tenantScope = app.getTenantScope(request);

      const payload = await fetchWithAnalyticsCache(
        app.redisClient,
        tenantScope.tenantId,
        "interventions",
        {
          from: from?.toISOString(),
          to: to?.toISOString(),
        },
        async () =>
          await executeInterventionsQuery({
            db: app.db,
            repos: app.repos,
            tenantId: tenantScope.tenantId,
            from,
            to,
          }),
      );

      return reply.status(200).send(payload);
    },
  );

  /**
   * GET /analytics/funnel — 5-stage recovery funnel progression
   */
  app.get(
    "/funnel",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = analyticsRangeQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new BadRequestError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const { from, to } = parseAndValidateDateRange(parseResult.data);
      const tenantScope = app.getTenantScope(request);

      const payload = await fetchWithAnalyticsCache(
        app.redisClient,
        tenantScope.tenantId,
        "funnel",
        {
          from: from?.toISOString(),
          to: to?.toISOString(),
        },
        async () =>
          await executeFunnelQuery({
            db: app.db,
            repos: app.repos,
            tenantId: tenantScope.tenantId,
            from,
            to,
          }),
      );

      return reply.status(200).send(payload);
    },
  );

  /**
   * GET /analytics/risk-mix — Risk mix counts and values across types and bands
   */
  app.get(
    "/risk-mix",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = analyticsRangeQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new BadRequestError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const { from, to } = parseAndValidateDateRange(parseResult.data);
      const tenantScope = app.getTenantScope(request);

      const payload = await fetchWithAnalyticsCache(
        app.redisClient,
        tenantScope.tenantId,
        "risk-mix",
        {
          from: from?.toISOString(),
          to: to?.toISOString(),
        },
        async () =>
          await executeRiskMixQuery({
            db: app.db,
            repos: app.repos,
            tenantId: tenantScope.tenantId,
            from,
            to,
          }),
      );

      return reply.status(200).send(payload);
    },
  );

  /**
   * GET /analytics/ai — AI performance, autonomy metrics, policy rejections, and cost economics
   */
  app.get(
    "/ai",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = analyticsRangeQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        throw new BadRequestError("Invalid query parameters", {
          issues: parseResult.error.issues,
        });
      }

      const { from, to } = parseAndValidateDateRange(parseResult.data);
      const tenantScope = app.getTenantScope(request);
      const isFinanceOrAdmin = ["FINANCE", "ADMIN"].includes(
        request.auth?.role ?? "",
      );

      if (!isFinanceOrAdmin) {
        reply.header("x-cost-data-redacted", "true");
      }

      const payload = await fetchWithAnalyticsCache(
        app.redisClient,
        tenantScope.tenantId,
        "ai",
        {
          from: from?.toISOString(),
          to: to?.toISOString(),
          isFinanceOrAdmin,
        },
        async () =>
          await executeAiPerformanceQuery({
            db: app.db,
            repos: app.repos,
            tenantId: tenantScope.tenantId,
            from,
            to,
            isFinanceOrAdmin,
          }),
      );

      return reply.status(200).send(payload);
    },
  );
};
