import { describe, expect, it, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  apiConfig,
  ConfigValidationError,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
} from "@repo/config";
import { buildApp } from "../app";
import { webhooksRoutes } from "../modules/webhooks/routes";

/**
 * s-07 §Technical Implementation: default 10s request budget + 25s webhook
 * budget. Covers the typed-config surface, the Fastify wiring in `buildApp`,
 * and the per-route webhook override.
 */

/** Minimal env satisfying every hard requirement; tests mutate from here. */
function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    DATABASE_URL: "postgres://postgres:postgres@localhost:5432/revenue_recovery",
    REDIS_URL: "redis://localhost:6379",
    TEMPORAL_ADDRESS: "localhost:7233",
    MOCK_PROVIDERS: "true",
  };
}

describe("s-07 request timeout budgets", () => {
  describe("typed config surface (@repo/config `http` group)", () => {
    it("defaults to 10s global + 25s webhook budget, frozen", () => {
      const config = apiConfig(baseEnv());
      expect(config.http.requestTimeoutMs).toBe(10000);
      expect(config.http.webhookTimeoutMs).toBe(25000);
      expect(config.http.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
      expect(config.http.webhookTimeoutMs).toBe(DEFAULT_WEBHOOK_TIMEOUT_MS);
      expect(Object.isFrozen(config.http)).toBe(true);
    });

    it("honors REQUEST_TIMEOUT_MS / WEBHOOK_TIMEOUT_MS overrides", () => {
      const config = apiConfig({
        ...baseEnv(),
        REQUEST_TIMEOUT_MS: "5000",
        WEBHOOK_TIMEOUT_MS: "30000",
      });
      expect(config.http.requestTimeoutMs).toBe(5000);
      expect(config.http.webhookTimeoutMs).toBe(30000);
    });

    it("rejects non-positive timeout values fail-fast", () => {
      for (const env of [
        { ...baseEnv(), REQUEST_TIMEOUT_MS: "0" },
        { ...baseEnv(), REQUEST_TIMEOUT_MS: "-100" },
        { ...baseEnv(), WEBHOOK_TIMEOUT_MS: "0" },
        { ...baseEnv(), WEBHOOK_TIMEOUT_MS: "-1" },
      ]) {
        let thrown: unknown = null;
        try {
          apiConfig(env);
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(ConfigValidationError);
      }
    });
  });

  describe("buildApp Fastify wiring", () => {
    const apps: FastifyInstance[] = [];
    afterAll(async () => {
      for (const app of apps) {
        await app.close();
      }
    });

    it("sets the Fastify socket-level requestTimeout to 10s by default", async () => {
      const app = await buildApp({
        config: apiConfig(baseEnv()),
        logger: false,
        disableRateLimit: true,
      });
      apps.push(app);
      await app.ready();

      expect(app.config.http.requestTimeoutMs).toBe(10000);
      expect(app.config.http.webhookTimeoutMs).toBe(25000);
      expect(app.server.requestTimeout).toBe(10000);
    });

    it("honors a REQUEST_TIMEOUT_MS override on the Fastify instance", async () => {
      const app = await buildApp({
        config: apiConfig({ ...baseEnv(), REQUEST_TIMEOUT_MS: "4500" }),
        logger: false,
        disableRateLimit: true,
      });
      apps.push(app);
      await app.ready();

      expect(app.server.requestTimeout).toBe(4500);
    });
  });

  describe("webhook routes carry the longer budget", () => {
    /**
     * Registers the real `webhooksRoutes` plugin in isolation and captures
     * `request.routeOptions` in an `onRequest` hook (registered before the
     * plugin, so it applies). Capture happens before any pre-handler, so no
     * DB/Redis/signing infrastructure is needed.
     */
    async function captureRouteOptions(
      env: Record<string, string>,
      method: "GET" | "POST",
      url: string,
    ): Promise<any> {
      const app = Fastify({ logger: false });
      (app as any).config = apiConfig(env);
      (app as any).eventBus = {
        publish: async () => {},
        close: async () => {},
      };
      let captured: any = null;
      app.addHook("onRequest", async (req) => {
        captured = (req as any).routeOptions;
      });
      await app.register(webhooksRoutes, { prefix: "/webhooks" });
      await app.ready();
      try {
        await app.inject({
          method,
          url,
          headers: { "content-type": "application/json" },
          payload: {},
        });
      } catch {
        // Handlers may fail without DB/Redis; routeOptions is captured first.
      }
      await app.close();
      return captured;
    }

    const webhookTargets: Array<[string, "GET" | "POST", string]> = [
      ["stripe", "POST", "/webhooks/stripe"],
      ["razorpay", "POST", "/webhooks/razorpay"],
      ["whatsapp verify", "GET", "/webhooks/whatsapp"],
      ["whatsapp ingest", "POST", "/webhooks/whatsapp"],
      ["email ingest", "POST", "/webhooks/email"],
      ["email token ingest", "POST", "/webhooks/email/sometoken"],
    ];

    for (const [label, method, url] of webhookTargets) {
      it(`${label} (${method} ${url}) has the 25s handlerTimeout budget`, async () => {
        const routeOptions = await captureRouteOptions(baseEnv(), method, url);
        expect(routeOptions).not.toBeNull();
        // Enforcement (Fastify v5 per-route override of the 10s default).
        expect(routeOptions.handlerTimeout).toBe(25000);
        // Discoverability mirror (s-07 "route-level config.requestTimeoutMs").
        expect(routeOptions.config?.requestTimeoutMs).toBe(25000);
      });
    }

    it("flows a WEBHOOK_TIMEOUT_MS override through to the routes", async () => {
      const routeOptions = await captureRouteOptions(
        { ...baseEnv(), WEBHOOK_TIMEOUT_MS: "30000" },
        "POST",
        "/webhooks/stripe",
      );
      expect(routeOptions.handlerTimeout).toBe(30000);
      expect(routeOptions.config?.requestTimeoutMs).toBe(30000);
    });
  });

  describe("Fastify v5 timeout semantics (documents the wiring choice)", () => {
    it("routes inherit the server handlerTimeout and can override per-route", async () => {
      const probe = Fastify({
        logger: false,
        requestTimeout: 10000,
        handlerTimeout: 10000,
      });
      probe.get("/default", async (req) => ({
        handlerTimeout: (req as any).routeOptions?.handlerTimeout,
      }));
      probe.get("/slow", { handlerTimeout: 25000 }, async (req) => ({
        handlerTimeout: (req as any).routeOptions?.handlerTimeout,
      }));

      const fallback = await probe.inject({ method: "GET", url: "/default" });
      const slow = await probe.inject({ method: "GET", url: "/slow" });
      expect(fallback.json().handlerTimeout).toBe(10000);
      expect(slow.json().handlerTimeout).toBe(25000);
      expect(probe.server.requestTimeout).toBe(10000);
      await probe.close();
    });

    it("handlerTimeout 503s the response and aborts request.signal", async () => {
      const probe = Fastify({ logger: false, handlerTimeout: 50 });
      let signalAborted = false;
      probe.get("/hang", async (req) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 300);
          req.signal.addEventListener(
            "abort",
            () => {
              signalAborted = true;
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        return { ok: true };
      });

      const res = await probe.inject({ method: "GET", url: "/hang" });
      expect(res.statusCode).toBe(503);
      expect(signalAborted).toBe(true);
      await probe.close();
    });
  });
});
