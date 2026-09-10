import { describe, expect, it, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { apiConfig, workerConfig, ConfigValidationError } from "@repo/config";
import { buildApp } from "../app";

/**
 * Startup self-check contract (s-33 §Tests, docs/deploy/environments.md).
 *
 * Containers must fail LOUDLY on minimal env — listing every missing key —
 * and prod-shape builds must omit /demo/* routes entirely (404, not 410).
 */

const LIVE_KEYS: Record<string, string> = {
  LLM_API_KEY: "test-llm-key",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  RAZORPAY_KEY_ID: "rzp_test_dummy",
  RAZORPAY_KEY_SECRET: "dummy",
  RAZORPAY_WEBHOOK_SECRET: "dummy",
  WHATSAPP_API_KEY: "dummy",
  WHATSAPP_PHONE_NUMBER_ID: "dummy",
  EMAIL_API_KEY: "dummy",
};

function prodShapeEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    NODE_ENV: "production",
    MOCK_PROVIDERS: "false",
    ...LIVE_KEYS,
  };
}

describe("s-33 startup self-check", () => {
  describe("fail-loud config (image-smoke contract)", () => {
    it("apiConfig with minimal env throws listing every missing key", () => {
      let message = "";
      try {
        apiConfig({});
        expect.fail("expected ConfigValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigValidationError);
        message = (err as ConfigValidationError).message;
      }
      for (const key of ["DATABASE_URL", "REDIS_URL", "TEMPORAL_ADDRESS"]) {
        expect(message).toContain(key);
      }
    });

    it("workerConfig with minimal env throws listing every missing key", () => {
      let message = "";
      try {
        workerConfig({});
        expect.fail("expected ConfigValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigValidationError);
        message = (err as ConfigValidationError).message;
      }
      expect(message).toContain("DATABASE_URL");
    });

    it("live mode (MOCK_PROVIDERS=false) requires every provider key by name", () => {
      let message = "";
      try {
        apiConfig({
          NODE_ENV: "production",
          MOCK_PROVIDERS: "false",
          DATABASE_URL: "postgres://localhost:5432/x",
          REDIS_URL: "redis://localhost:6379",
          TEMPORAL_ADDRESS: "localhost:7233",
        });
        expect.fail("expected ConfigValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigValidationError);
        message = (err as ConfigValidationError).message;
      }
      for (const key of Object.keys(LIVE_KEYS)) {
        expect(message).toContain(key);
      }
    });
  });

  describe("demo-route omission in prod-shape", () => {
    const apps: FastifyInstance[] = [];
    afterAll(async () => {
      for (const app of apps) {
        await app.close();
      }
    });

    it("POST /demo/* is 404 when production + MOCK_PROVIDERS=false", async () => {
      const app = await buildApp({
        config: apiConfig(prodShapeEnv()),
        logger: false,
        disableRateLimit: true,
      });
      apps.push(app);
      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/demo/payment-fail",
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("POST /demo/* is registered when mock mode is on (not 404)", async () => {
      const app = await buildApp({
        logger: false,
        disableRateLimit: true,
      });
      apps.push(app);
      await app.ready();

      const res = await app.inject({
        method: "POST",
        url: "/demo/payment-fail",
        payload: {},
      });
      // demoGuard passes mock check, then auth rejects the anonymous call —
      // anything but 404 proves the route is registered in non-prod-shape.
      expect(res.statusCode).not.toBe(404);
    });
  });
});
