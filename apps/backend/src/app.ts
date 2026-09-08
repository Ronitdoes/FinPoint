import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import Redis from "ioredis";
import { randomUUID } from "node:crypto";
import { apiConfig, type ServerConfig } from "@repo/config";

import { contextPlugin } from "./plugins/context";
import { loggerPlugin, createLoggerConfig } from "./plugins/logger";
import { corsPlugin } from "./plugins/cors";
import { rateLimitPlugin } from "./plugins/rate-limit";
import { rateLimitKeyGenerator } from "./plugins/rate-limit-policy";
import { recordRatelimitHit } from "@repo/observability";
import { IpBlockService, checkIpBlock } from "./modules/security/ip-block.service";
import { dbPlugin, type Repositories } from "./plugins/db";
import { errorHandlerPlugin } from "./plugins/error-handler";
import { otelPlugin } from "./plugins/otel";
import { shutdownPlugin } from "./plugins/shutdown";
import { authPlugin } from "./plugins/auth";
import { rbacPlugin } from "./plugins/rbac";
import { registerRouteModules } from "./lib/routes";
import { registerJobs, type JobsOptions } from "./jobs";
import { registerRiskConsumer } from "./modules/risk/consumer";
import { registerCaseConsumer } from "./modules/cases/consumer";
import type { Database } from "@repo/db";
import { createEventBus, NullBus, type EventBus } from "@repo/integrations";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string | Buffer;
  }
  interface FastifyInstance {
    eventBus: EventBus;
    config: ServerConfig;
  }
}

export interface AppOptions {
  config?: ServerConfig;
  customDb?: Database;
  customRepos?: Repositories;
  customHealthCheck?: () => Promise<boolean>;
  redisClient?: Redis | null;
  trustProxy?: boolean;
  disableRateLimit?: boolean;
  logger?: FastifyServerOptions["logger"];
  eventBus?: EventBus;
  jobs?: JobsOptions;
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

  // Register raw body preserving parser for JSON payloads (s-10 §Requirements 2)
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      (req as any).rawBody = body.toString("utf8");
      if (body.length === 0) {
        return done(null, {});
      }
      try {
        const json = JSON.parse(body.toString("utf8"));
        done(null, json);
      } catch (err: any) {
        err.statusCode = 400;
        done(err, undefined);
      }
    },
  );

  // Decorate fastify with EventBus and ServerConfig (s-11)
  const eventBus = opts.eventBus ?? createEventBus(config.bus);
  app.decorate("eventBus", eventBus);
  app.decorate("config", config);

  // Close event bus cleanly on app shutdown
  app.addHook("onClose", async () => {
    try {
      if (eventBus && typeof eventBus.close === "function") {
        await eventBus.close();
      }
    } catch {
      // ignore teardown errors
    }
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

  // 4. Rate Limiting plugin (s-30 per-class policy; identity-keyed)
  if (!opts.disableRateLimit) {
    await app.register(rateLimitPlugin, {
      redis,
      skipOnError: true,
      keyGenerator: rateLimitKeyGenerator,
      onLimitExceeded: (_req, routeClass) => {
        try {
          recordRatelimitHit(routeClass);
        } catch {
          // metrics must never break request handling
        }
      },
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

  // 9. Auth & Sessions plugin
  await app.register(authPlugin, {
    sessionSecret: config.auth?.sessionSecret,
  });

  // 9b. Abuse protection: temporary IP blocks after repeated signature
  // failures (s-30). Decorated before routes so guards can reference it.
  const ipBlockService = new IpBlockService(redis);
  app.decorate("ipBlockService", ipBlockService);
  app.decorate("checkIpBlock", checkIpBlock);

  // 10. RBAC Role checking plugin
  await app.register(rbacPlugin);

  // 11. Register feature route modules
  await registerRouteModules(app);

  // 12. Register risk engine event consumer (s-12)
  registerRiskConsumer(app);

  // 13. Register case orchestrator event consumer (s-17)
  registerCaseConsumer(app);

  // 14. Register background reconciliation jobs (s-31; opt-in, off in tests)
  registerJobs(app, opts.jobs);

  return app;
}
