import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { buildApp } from "./app";
import {
  ValidationError,
  UnauthenticatedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  IdempotencyInFlightError,
  RateLimitedError,
  InternalError,
} from "./lib/errors";

describe("Step 07 — Backend Application Skeleton (Fastify)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      logger: false, // silence test logs
      disableRateLimit: true, // test custom rate limiting in dedicated block
    });

    // Register dummy test routes to verify error handling & validation
    app.get("/test/domain-error/:type", async (req) => {
      const type = (req.params as any).type;
      switch (type) {
        case "validation":
          throw new ValidationError("Invalid field format", { field: "email" });
        case "unauthenticated":
          throw new UnauthenticatedError("API key missing or expired");
        case "forbidden":
          throw new ForbiddenError("Role VIEWER cannot modify policies");
        case "not-found":
          throw new NotFoundError("Recovery case not found", { caseId: "123" });
        case "conflict":
          throw new ConflictError("Subscription already active");
        case "idempotency":
          throw new IdempotencyInFlightError("Duplicate request in progress", 5);
        case "rate-limit":
          throw new RateLimitedError("Too many attempts", 30);
        case "internal":
          throw new InternalError("Calculation overflow");
        default:
          throw new Error("Generic unhandled exception with sensitive stack trace");
      }
    });

    app.post("/test/zod-validation", async (req) => {
      const schema = z.object({
        tenantId: z.string().uuid(),
        amount: z.number().int().positive(),
      });
      const parsed = schema.parse(req.body);
      return { success: true, data: parsed };
    });

    app.post(
      "/test/fastify-schema",
      {
        schema: {
          body: {
            type: "object",
            required: ["code"],
            properties: {
              code: { type: "string", minLength: 3 },
            },
          },
        },
      },
      async (req) => {
        return { ok: true, body: req.body };
      },
    );

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe("1. Health & Meta Endpoints", () => {
    it("GET /health returns 200 with uptime and timestamp", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.status).toBe("ok");
      expect(typeof json.uptime).toBe("number");
      expect(typeof json.timestamp).toBe("string");
    });

    it("GET /api/health returns 200 as backward-compatible alias", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/health",
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.status).toBe("ok");
      expect(typeof json.uptime).toBe("number");
    });

    it("GET /version returns 200 with application metadata", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/version",
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.name).toBe("AI-Revenue-Recovery Backend");
      expect(json.version).toBe("0.1.0");
      expect(typeof json.gitSha).toBe("string");
      expect(typeof json.env).toBe("string");
    });

    it("GET / and GET /api return 200 with discovery links", async () => {
      const resRoot = await app.inject({ method: "GET", url: "/" });
      expect(resRoot.statusCode).toBe(200);
      expect(resRoot.json().endpoints.health).toBe("/health");

      const resApi = await app.inject({ method: "GET", url: "/api" });
      expect(resApi.statusCode).toBe(200);
      expect(resApi.json().status).toBe("running");
    });

    it("GET /ready returns 200 when database healthcheck is positive", async () => {
      const healthyApp = await buildApp({
        logger: false,
        disableRateLimit: true,
        customHealthCheck: async () => true,
        redisClient: null,
      });

      const res = await healthyApp.inject({
        method: "GET",
        url: "/ready",
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.status).toBe("ready");
      expect(json.checks.db).toBe("up");

      await healthyApp.close();
    });

    it("GET /ready returns 503 when database is down", async () => {
      const failingApp = await buildApp({
        logger: false,
        disableRateLimit: true,
        customHealthCheck: async () => false,
        redisClient: null,
      });

      const res = await failingApp.inject({
        method: "GET",
        url: "/ready",
      });

      expect(res.statusCode).toBe(503);
      const json = res.json();
      expect(json.status).toBe("unhealthy");
      expect(json.checks.db).toBe("down");

      await failingApp.close();
    });
  });

  describe("2. Request Context & Correlation Tracking", () => {
    it("generates UUID request-id and correlation-id when omitted", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(res.headers["x-request-id"]).toBeDefined();
      expect(typeof res.headers["x-request-id"]).toBe("string");
      expect(res.headers["x-correlation-id"]).toBeDefined();
    });

    it("preserves and echoes incoming x-correlation-id header", async () => {
      const customCorrId = "corr-test-12345-abcde";
      const res = await app.inject({
        method: "GET",
        url: "/health",
        headers: {
          "x-correlation-id": customCorrId,
        },
      });

      expect(res.headers["x-correlation-id"]).toBe(customCorrId);
    });

    it("extracts trace ID from W3C traceparent header", async () => {
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const traceparent = `00-${traceId}-00f067aa0ba902b7-01`;

      const res = await app.inject({
        method: "GET",
        url: "/health",
        headers: {
          traceparent,
        },
      });

      expect(res.headers["x-correlation-id"]).toBe(traceId);
    });
  });

  describe("3. Error Envelope & Domain Error Status Mappings", () => {
    it("returns 404 with canonical envelope for unknown routes", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/non-existent-route-xyz",
      });

      expect(res.statusCode).toBe(404);
      const json = res.json();
      expect(json).toEqual({
        error: {
          code: "NOT_FOUND",
          message: "Route GET /non-existent-route-xyz not found",
          details: {
            path: "/non-existent-route-xyz",
            method: "GET",
          },
        },
      });
    });

    it("maps ValidationError to 422 with VALIDATION code", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/test/domain-error/validation",
      });

      expect(res.statusCode).toBe(422);
      const json = res.json();
      expect(json.error.code).toBe("VALIDATION");
      expect(json.error.message).toBe("Invalid field format");
      expect(json.error.details).toEqual({ field: "email" });
    });

    it("maps UnauthenticatedError to 401 with UNAUTHENTICATED code", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/test/domain-error/unauthenticated",
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    });

    it("maps ForbiddenError to 403 with FORBIDDEN code", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/test/domain-error/forbidden",
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    });

    it("maps NotFoundError to 404 with NOT_FOUND code", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/test/domain-error/not-found",
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    });

    it("maps ConflictError to 409 with CONFLICT code", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/test/domain-error/conflict",
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("CONFLICT");
    });

    it("maps IdempotencyInFlightError to 409 with Retry-After header", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/test/domain-error/idempotency",
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("IDEMPOTENCY_IN_FLIGHT");
      expect(res.headers["retry-after"]).toBe("5");
    });

    it("maps RateLimitedError to 429 with Retry-After header", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/test/domain-error/rate-limit",
      });

      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe("RATE_LIMITED");
      expect(res.headers["retry-after"]).toBe("30");
    });

    it("maps unhandled server exception to 500 without leaking stack", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/test/domain-error/generic",
      });

      expect(res.statusCode).toBe(500);
      const json = res.json();
      expect(json.error.code).toBe("INTERNAL");
      expect(json.error.message).toBe("An internal server error occurred");
      expect(json.error.details).toEqual({});
      // Ensure no stack traces or sensitive internal paths leak
      expect(JSON.stringify(json)).not.toContain("stack");
      expect(JSON.stringify(json)).not.toContain("Generic unhandled exception");
    });

    it("maps Zod validation error to 422 with issues list", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/zod-validation",
        payload: {
          tenantId: "not-a-uuid",
          amount: -50,
        },
      });

      expect(res.statusCode).toBe(422);
      const json = res.json();
      expect(json.error.code).toBe("VALIDATION");
      expect(Array.isArray(json.error.details)).toBe(true);
      expect(json.error.details.length).toBeGreaterThanOrEqual(2);
    });

    it("maps Fastify schema validation error to 422 with details", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/fastify-schema",
        payload: {
          code: "a", // too short, requires minLength 3
        },
      });

      expect(res.statusCode).toBe(422);
      const json = res.json();
      expect(json.error.code).toBe("VALIDATION");
    });
  });

  describe("4. Body Limits & Parsing Security", () => {
    it("accepts valid JSON payload within 256KB", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/fastify-schema",
        payload: {
          code: "VALID_CODE",
        },
      });

      expect(res.statusCode).toBe(200);
    });

    it("rejects payload exceeding 256KB limit with 413", async () => {
      const largeString = "x".repeat(300 * 1024); // 300KB
      const res = await app.inject({
        method: "POST",
        url: "/test/fastify-schema",
        payload: {
          code: largeString,
        },
      });

      expect(res.statusCode).toBe(413);
      const json = res.json();
      expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
    });

    it("handles malformed JSON with 400 canonical error", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test/fastify-schema",
        headers: {
          "content-type": "application/json",
        },
        payload: "{ invalid-json-payload",
      });

      expect(res.statusCode).toBe(400);
      const json = res.json();
      expect(json.error.code).toBe("BAD_REQUEST");
    });
  });

  describe("5. CORS & Preflight", () => {
    it("handles OPTIONS preflight request with allowed headers", async () => {
      const res = await app.inject({
        method: "OPTIONS",
        url: "/health",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "POST",
          "access-control-request-headers": "Content-Type, X-Correlation-ID",
        },
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
      expect(res.headers["access-control-allow-methods"]).toContain("POST");
    });
  });

  describe("6. Graceful Shutdown & In-Flight Tracking", () => {
    it("tracks in-flight requests and decrements on response", async () => {
      expect(app.getInFlightCount()).toBe(0);

      // Trigger a request
      const res = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(res.statusCode).toBe(200);
      expect(app.getInFlightCount()).toBe(0);
    });

    it("drainInFlight completes immediately when count is 0", async () => {
      const start = Date.now();
      await app.drainInFlight(1000);
      expect(Date.now() - start).toBeLessThan(100);
    });
  });

  describe("7. Rate Limiting", () => {
    it("enforces rate limits and formats 429 response canonical envelope", async () => {
      const rateLimitedApp = await buildApp({
        logger: false,
        disableRateLimit: false,
        redisClient: null, // use in-memory store for predictable unit test isolation
      });

      // Register route with low limit
      rateLimitedApp.get(
        "/test/limited",
        {
          config: {
            rateLimit: {
              max: 2,
              timeWindow: 10000,
            },
          },
        },
        async () => ({ ok: true }),
      );

      await rateLimitedApp.ready();

      // Request 1: ok
      const r1 = await rateLimitedApp.inject({ method: "GET", url: "/test/limited" });
      expect(r1.statusCode).toBe(200);

      // Request 2: ok
      const r2 = await rateLimitedApp.inject({ method: "GET", url: "/test/limited" });
      expect(r2.statusCode).toBe(200);

      // Request 3: rate limited
      const r3 = await rateLimitedApp.inject({ method: "GET", url: "/test/limited" });
      expect(r3.statusCode).toBe(429);
      const json = r3.json();
      expect(json.error.code).toBe("RATE_LIMITED");
      expect(r3.headers["retry-after"]).toBeDefined();

      await rateLimitedApp.close();
    });
  });
});
