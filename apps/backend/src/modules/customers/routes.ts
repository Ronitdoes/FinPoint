import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { ValidationError } from "../../lib/errors";
import { CustomerContextService } from "./customer-context.service";
import { ContextPurposeSchema } from "./context/types";

const getContextQuerySchema = z.object({
  purpose: ContextPurposeSchema.default("api_read"),
  fresh: z.coerce.boolean().optional().default(false),
});

const getContextParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Fastify routes for Customer module (Spec 01 §9, s-13 §API Contracts).
 * Provides tenant-isolated, allowlisted, size-bounded customer context snapshots.
 */
export const customersRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /customers/:id/context — Customer context snapshot
   * Auth: session or api-key, role >= VIEWER
   * Query: ?purpose=ai_decision|api_read (default: api_read)
   * Headers returned: X-Context-Built-At, X-Context-Bytes
   */
  app.get(
    "/:id/context",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("VIEWER", "SUPPORT", "OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseParams = getContextParamsSchema.safeParse(request.params);
      if (!parseParams.success) {
        throw new ValidationError("Invalid customer ID format", {
          issues: parseParams.error.issues,
        });
      }

      const parseQuery = getContextQuerySchema.safeParse(request.query);
      if (!parseQuery.success) {
        throw new ValidationError("Invalid query parameters", {
          issues: parseQuery.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const customerId = parseParams.data.id;
      const { purpose, fresh } = parseQuery.data;

      const context = await CustomerContextService.build({
        tenantId: tenantScope.tenantId,
        customerId,
        purpose,
        forceFresh: fresh,
        db: app.db,
        repos: app.repos,
        redis: app.redisClient,
      });

      const serialized = JSON.stringify(context);
      const bytes = Buffer.byteLength(serialized, "utf8");

      return reply
        .header("X-Context-Built-At", context.built_at)
        .header("X-Context-Bytes", String(bytes))
        .status(200)
        .send(context);
    },
  );
};
