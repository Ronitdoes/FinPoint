import type { FastifyPluginAsync } from "fastify";
import { MetaService } from "./meta.service";

export interface MetaRoutesOptions {
  metaService?: MetaService;
}

export const metaRoutes: FastifyPluginAsync<MetaRoutesOptions> = async (
  fastify,
  opts,
) => {
  const metaService =
    opts.metaService ||
    new MetaService({
      dbHealthCheck: () => fastify.dbHealthCheck(),
      redisClient: (fastify as any).redisClient,
    });

  // GET /health — Process liveness probe
  fastify.get("/health", async (_req, reply) => {
    return reply.status(200).send(metaService.getHealth());
  });

  // GET /api/health — Backward-compatible alias
  fastify.get("/api/health", async (_req, reply) => {
    return reply.status(200).send(metaService.getHealth());
  });

  // GET /ready — Dependency readiness probe (DB, Redis, Temporal)
  fastify.get("/ready", async (_req, reply) => {
    const result = await metaService.getReadiness();
    const statusCode = result.isReady ? 200 : 503;
    return reply.status(statusCode).send(result);
  });

  // GET /version — Application metadata
  fastify.get("/version", async (_req, reply) => {
    return reply.status(200).send(metaService.getVersion());
  });

  // GET / & GET /api — Service root & discovery
  const rootHandler = async (_req: unknown, reply: any) => {
    const version = metaService.getVersion();
    return reply.status(200).send({
      name: version.name,
      version: version.version,
      status: "running",
      endpoints: {
        health: "/health",
        apiHealth: "/api/health",
        ready: "/ready",
        version: "/version",
      },
    });
  };

  fastify.get("/", rootHandler);
  fastify.get("/api", rootHandler);
};
