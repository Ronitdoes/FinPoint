import { config as loadEnv } from "dotenv";
import path from "node:path";
import { apiConfig } from "@repo/config";
import { buildApp } from "./app";

// Dev convenience: load the repo-root .env
loadEnv({ path: path.resolve(import.meta.dirname, "../../../.env") });

export async function startServer() {
  const config = apiConfig();
  const app = await buildApp({ config });

  let isShuttingDown = false;

  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;

    app.log.info({ signal }, `Received ${signal}, initiating graceful shutdown...`);

    const shutdownTimer = setTimeout(() => {
      app.log.error("Shutdown deadline exceeded (25s), forcing exit");
      process.exit(1);
    }, 25000);

    try {
      // 1. Stop accepting new HTTP connections
      await app.close();
      app.log.info("HTTP server closed to new connections");

      // 2. Drain active in-flight requests (max 20s per spec)
      await app.drainInFlight(20000);
      app.log.info("In-flight requests drained");

      // 3. Close database connection pool
      await app.closeDb();
      app.log.info("Database connection pool closed");

      // 4. Close Redis client if present
      const redisClient = (app as any).redisClient;
      if (redisClient && typeof redisClient.quit === "function") {
        await redisClient.quit();
        app.log.info("Redis connection closed");
      }

      // 5. Flush and shutdown OpenTelemetry tracing
      const { shutdownTracing } = await import("@repo/observability");
      await shutdownTracing();
      app.log.info("OpenTelemetry tracing provider flushed and closed");

      clearTimeout(shutdownTimer);
      app.log.info("Graceful shutdown completed successfully");
      process.exit(0);
    } catch (err) {
      clearTimeout(shutdownTimer);
      app.log.error({ err }, "Error occurred during graceful shutdown");
      process.exit(1);
    }
  }

  // Register signal listeners
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Process error handlers (never run half-dead per CONVENTIONS §11 & specs/steps/s-07.md)
  process.on("uncaughtException", (err) => {
    app.log.fatal({ err }, "Uncaught exception detected, terminating process");
    shutdown("uncaughtException").finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    app.log.fatal({ reason }, "Unhandled promise rejection detected, terminating process");
    shutdown("unhandledRejection").finally(() => process.exit(1));
  });

  const host = "0.0.0.0";
  const port = config.app.port;

  try {
    await app.listen({ port, host });
    app.log.info(`🚀 Fastify backend listening at http://${host}:${port}`);
    return app;
  } catch (err) {
    app.log.fatal({ err }, "Failed to bind backend port, terminating");
    process.exit(1);
  }
}

// Auto-boot if executed directly via bun
if (import.meta.main) {
  startServer();
}
