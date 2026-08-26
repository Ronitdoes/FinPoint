import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { apiConfig, type ServerConfig } from "@repo/config";

import { contextPlugin } from "./plugins/context";
import { loggerPlugin, createLoggerConfig } from "./plugins/logger";
import { corsPlugin } from "./plugins/cors";
import { rateLimitPlugin } from "./plugins/rate-limit";
import { dbPlugin, type Repositories } from "./plugins/db";
import { errorHandlerPlugin } from "./plugins/error-handler";
import { otelPlugin } from "./plugins/otel";
import { shutdownPlugin } from "./plugins/shutdown";
import { registerRouteModules } from "./lib/routes";
import type { Database } from "@repo/db";

export interface AppOptions {
  config?: ServerConfig;
  customDb?: Database;
  customRepos?: Repositories;
  customHealthCheck?: () => Promise<boolean>;
  redisClient?: Redis | null;
  trustProxy?: boolean;
  disableRateLimit?: boolean;
  logger?: FastifyServerOptions["logger"];
}

/**
 * Builds and configures a Fastify application instance.
 * Testable without listening on a network port (inject/fetch compatible).
 */
export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const config = opts.config ?? apiConfig();
  const logLevel = config.app.logLevel || "info";

  const loggerOptions = opts.logger !== undefined ? opts.logger : createLoggerConfig(logLevel);

  const app = Fastify({
    logger: loggerOptions,
    bodyLimit: 256 * 1024, // 256KB strict limit (specs/steps/s-07.md §Technical Implementation)
    trustProxy: opts.trustProxy ?? false,
    requestIdHeader: "x-request-id",
    genReqId: () => randomUUID(),
  });

  // Redis client setup for rate limiting & caching
  let redis: Redis | null = null;
  let internallyCreatedRedis = false;

  if (opts.redisClient !== undefined) {
    redis = opts.redisClient;
  } else if (config.redis?.url) {
    try {
      redis = new Redis(config.redis.url, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: true,
        retryStrategy: (times) => (times > 3 ? null : 100),
      });
      internallyCreatedRedis = true;
      // Attach error handler to prevent unhandled error crashes
      redis.on("error", (err) => {
        app.log.warn({ err: err.message }, "Redis connection warning (degraded mode active)");
      });
    } catch {
      redis = null;
    }
  }

  // Decorate fastify with redis client for meta service probes & plugins
  app.decorate("redisClient", redis);

  // Hook to cleanly disconnect internally created Redis on app close
  if (internallyCreatedRedis && redis) {
    const clientToClose = redis;
    app.addHook("onClose", async () => {
      try {
        if (clientToClose.status !== "end") {
          clientToClose.disconnect();
        }
      } catch {
        // ignore close errors
      }
    });
  }

  // 1. Context plugin (Request ID, Correlation ID, child logger binding)
  await app.register(contextPlugin);

  // 2. Logger plugin (Request duration metric recording)
  await app.register(loggerPlugin);

  // 3. CORS plugin
  await app.register(corsPlugin, {
    isProduction: config.app.env === "production",
  });

  // 4. Rate Limiting plugin
  if (!opts.disableRateLimit) {
    await app.register(rateLimitPlugin, {
      redis,
      skipOnError: true,
    });
  }

  // 5. Database & Repositories plugin
  await app.register(dbPlugin, {
    customDb: opts.customDb,
    customRepos: opts.customRepos,
    customHealthCheck: opts.customHealthCheck,
  });

  // 6. Central Error Handler & 404 plugin
  await app.register(errorHandlerPlugin);

  // 7. OpenTelemetry plugin placeholder
  await app.register(otelPlugin);

  // 8. Graceful Shutdown & In-flight tracking plugin
  await app.register(shutdownPlugin);

  // 9. Register feature route modules
  await registerRouteModules(app);

  return app;
}
