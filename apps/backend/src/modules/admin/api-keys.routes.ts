import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  createApiKeySchema,
  type CreateApiKeyInput,
} from "./types";
import {
  createTenantApiKey,
  revokeTenantApiKey,
  listTenantApiKeys,
} from "./service";
import { rateLimitFor } from "../../plugins/rate-limit-policy";
import { ValidationError } from "../../lib/errors";

export const adminApiKeysRoutes: FastifyPluginAsync = async (
  fastify: FastifyInstance,
) => {
  // All admin API key routes require authenticated session/key and ADMIN role
  const adminGuards = [fastify.requireAuth, fastify.requireRole("ADMIN")];

  /**
   * POST /admin/api-keys — Issue a new machine API key for current tenant.
   * Returns plaintext raw key string exactly once.
   */
  fastify.post<{ Body: CreateApiKeyInput }>(
    "/api-keys",
    { preHandler: adminGuards },
    async (request, reply) => {
      const { tenantId } = fastify.getTenantScope(request);

      const parseResult = createApiKeySchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new ValidationError("Invalid create API key payload", parseResult.error.issues);
      }

      if (
        parseResult.data.scopes?.includes("demo") &&
        fastify.config?.demo?.mockProviders === false
      ) {
        throw new ValidationError(
          "Demo API key scope cannot be granted when mock providers are disabled (MOCK_PROVIDERS=false)",
        );
      }

      const apiKey = await createTenantApiKey({
        db: fastify.db,
        repos: fastify.repos,
        tenantId,
        createdBy: request.auth?.userId,
        input: parseResult.data,
      });

      return reply.status(201).send(apiKey);
    },
  );

  /**
   * DELETE /admin/api-keys/:id — Revoke a machine API key immediately.
   */
  fastify.delete<{ Params: { id: string } }>(
    "/api-keys/:id",
    { preHandler: adminGuards },
    async (request, reply) => {
      const { tenantId } = fastify.getTenantScope(request);
      const id = request.params.id;

      await revokeTenantApiKey({
        db: fastify.db,
        repos: fastify.repos,
        redisClient: fastify.redisClient,
        tenantId,
        id,
      });

      return reply.status(204).send();
    },
  );

  /**
   * GET /admin/api-keys — List all machine API keys for current tenant.
   */
  fastify.get(
    "/api-keys",
    { preHandler: adminGuards, config: { rateLimit: rateLimitFor("read") } },
    async (request, reply) => {
      const { tenantId } = fastify.getTenantScope(request);

      const apiKeys = await listTenantApiKeys({
        db: fastify.db,
        repos: fastify.repos,
        tenantId,
      });

      return reply.status(200).send(apiKeys);
    },
  );
};
