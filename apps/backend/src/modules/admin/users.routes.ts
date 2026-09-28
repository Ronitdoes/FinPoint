import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import {
  createUserSchema,
  updateUserSchema,
  type CreateUserInput,
  type UpdateUserInput,
} from "./types";
import {
  createTenantUser,
  updateTenantUser,
  listTenantUsers,
} from "./service";
import { rateLimitFor } from "../../plugins/rate-limit-policy";
import { ValidationError } from "../../lib/errors";

export const adminUsersRoutes: FastifyPluginAsync = async (
  fastify: FastifyInstance,
) => {
  // Admin user management: session ADMIN only for humans, or machine keys
  // with explicit `admin:manage` scope (least privilege — s-09 fix).
  // Previously any valid `rrk_` key passed via role ADMIN; now scope-gated.
  const adminGuards = [
    fastify.requireAuth,
    fastify.requireRole("ADMIN"),
    fastify.requireScope("admin:manage"),
  ];

  /**
   * POST /admin/users — Provision a new operator user in current tenant.
   */
  fastify.post<{ Body: CreateUserInput }>(
    "/users",
    { preHandler: adminGuards },
    async (request, reply) => {
      const { tenantId } = fastify.getTenantScope(request);

      const parseResult = createUserSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new ValidationError("Invalid create user payload", parseResult.error.issues);
      }

      const user = await createTenantUser({
        db: fastify.db,
        repos: fastify.repos,
        tenantId,
        input: parseResult.data,
      });

      return reply.status(201).send({ user });
    },
  );

  /**
   * PATCH /admin/users/:id — Update role or status of tenant operator.
   */
  fastify.patch<{ Params: { id: string }; Body: UpdateUserInput }>(
    "/users/:id",
    { preHandler: adminGuards },
    async (request, reply) => {
      const { tenantId } = fastify.getTenantScope(request);
      const userId = request.params.id;

      const parseResult = updateUserSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new ValidationError("Invalid update user payload", parseResult.error.issues);
      }

      const user = await updateTenantUser({
        db: fastify.db,
        repos: fastify.repos,
        redisClient: fastify.redisClient,
        tenantId,
        userId,
        input: parseResult.data,
      });

      return reply.status(200).send({ user });
    },
  );

  /**
   * GET /admin/users — List operators in current tenant.
   */
  fastify.get(
    "/users",
    { preHandler: adminGuards, config: { rateLimit: rateLimitFor("read") } },
    async (request, reply) => {
      const { tenantId } = fastify.getTenantScope(request);

      const users = await listTenantUsers({
        db: fastify.db,
        repos: fastify.repos,
        tenantId,
      });

      return reply.status(200).send({ users });
    },
  );
};
