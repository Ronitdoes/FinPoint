/**
 * Rate-limit & abuse-policy verification (Step 30 §Requirements 4).
 *
 *  - The finalized per-class policy table matches the step contract
 *    (webhooks 600/min/IP, auth 5/min, reads 120/min/key, /events 60/min,
 *    demo 60/min with prod omission).
 *  - Caller-identity keying budgets per API key and never leaks the raw
 *    credential into the counter key.
 *  - `IpBlockService` blocks an IP after repeated signature failures and
 *    releases it via TTL or the ADMIN clear path.
 *  - End-to-end (needs DB): bad webhook signatures accumulate, trip a
 *    temporary 429 `IP_BLOCKED` with `Retry-After`, and clear via
 *    `DELETE /admin/ip-blocks/:ip`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import {
  RATE_LIMIT_POLICIES,
  rateLimitFor,
  rateLimitKeyGenerator,
  type RateLimitRouteClass,
} from "../../apps/backend/src/plugins/rate-limit-policy";
import { classifyRateLimitRoute } from "../../apps/backend/src/plugins/rate-limit";
import {
  IpBlockService,
  checkIpBlock,
} from "../../apps/backend/src/modules/security/ip-block.service";
import { buildApp } from "../../apps/backend/src/app";
import { NullBus } from "@repo/integrations";
import {
  db,
  createTenant,
  createApiKey,
  createUser,
  createSession,
} from "@repo/db";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("abuse-limits: finalized policy table", () => {
  it("matches the s-30 contract per route class", () => {
    expect(RATE_LIMIT_POLICIES.webhook).toMatchObject({ max: 600 });
    expect(RATE_LIMIT_POLICIES.authLogin).toMatchObject({ max: 5 });
    expect(RATE_LIMIT_POLICIES.read).toMatchObject({ max: 120 });
    expect(RATE_LIMIT_POLICIES.events).toMatchObject({ max: 60 });
    expect(RATE_LIMIT_POLICIES.demo).toMatchObject({ max: 60 });
    expect(RATE_LIMIT_POLICIES.providerStatus).toMatchObject({ max: 30 });
    for (const policy of Object.values(RATE_LIMIT_POLICIES)) {
      expect(policy.timeWindow).toBe("1 minute");
    }
  });

  it("exposes every policy class through rateLimitFor", () => {
    const classes: RateLimitRouteClass[] = [
      "webhook",
      "authLogin",
      "read",
      "events",
      "demo",
      "providerStatus",
    ];
    for (const routeClass of classes) {
      expect(rateLimitFor(routeClass)).toEqual({
        max: RATE_LIMIT_POLICIES[routeClass].max,
        timeWindow: "1 minute",
      });
    }
  });

  it("classifies request URLs into observability route classes", () => {
    expect(classifyRateLimitRoute("/webhooks/stripe")).toBe("webhook");
    expect(classifyRateLimitRoute("/webhooks/whatsapp?x=1")).toBe("webhook");
    expect(classifyRateLimitRoute("/auth/login")).toBe("auth");
    expect(classifyRateLimitRoute("/events")).toBe("events");
    expect(classifyRateLimitRoute("/events/replay")).toBe("events");
    expect(classifyRateLimitRoute("/demo/payment-fail")).toBe("demo");
    expect(
      classifyRateLimitRoute("/payments/123e4567-e89b-12d3-a456-426614174000/status"),
    ).toBe("providerStatus");
    expect(classifyRateLimitRoute("/cases")).toBe("read");
    expect(classifyRateLimitRoute("/analytics/summary")).toBe("read");
  });
});

describe("abuse-limits: caller-identity keying", () => {
  const req = (headers: Record<string, string>, ip = "10.0.0.1") =>
    ({ headers, ip }) as never;

  it("keys authenticated callers by credential digest, not raw secret", () => {
    const rawHeader = `Bearer rrk_tenant_${randomUUID().replace(/-/g, "")}`;
    const first = rateLimitKeyGenerator(req({ authorization: rawHeader }));
    const second = rateLimitKeyGenerator(req({ authorization: rawHeader }, "10.0.0.2"));

    expect(first).toBe(second);
    expect(first.startsWith("key:")).toBe(true);
    expect(first.includes(rawHeader)).toBe(false);
    expect(first.includes("rrk_")).toBe(false);
  });

  it("keys different credentials and anonymous IPs apart", () => {
    const a = rateLimitKeyGenerator(req({ authorization: "Bearer key_a" }));
    const b = rateLimitKeyGenerator(req({ authorization: "Bearer key_b" }));
    const anonA = rateLimitKeyGenerator(req({}, "10.0.0.9"));
    const anonB = rateLimitKeyGenerator(req({}, "10.0.0.10"));

    expect(a).not.toBe(b);
    expect(anonA).toBe("ip:10.0.0.9");
    expect(anonB).toBe("ip:10.0.0.10");
  });
});

describe("abuse-limits: IpBlockService (in-memory fallback)", () => {
  it("blocks after the threshold and releases via clear", async () => {
    const service = new IpBlockService(null, {
      failureThreshold: 3,
      failureWindowSeconds: 600,
      blockTtlSeconds: 600,
    });
    const warnings: unknown[] = [];
    const log = { warn: (obj: unknown) => warnings.push(obj) };

    expect((await service.recordSignatureFailure("9.9.9.9", "STRIPE", log)).blocked).toBe(false);
    expect((await service.recordSignatureFailure("9.9.9.9", "STRIPE", log)).blocked).toBe(false);
    const third = await service.recordSignatureFailure("9.9.9.9", "STRIPE", log);
    expect(third.blocked).toBe(true);
    expect(third.failures).toBe(3);

    const status = await service.isBlocked("9.9.9.9");
    expect(status.blocked).toBe(true);
    expect(status.ttlSeconds).toBeGreaterThan(0);

    // Unrelated IPs are unaffected.
    expect((await service.isBlocked("9.9.9.10")).blocked).toBe(false);

    await service.clearIpBlock("9.9.9.9");
    expect((await service.isBlocked("9.9.9.9")).blocked).toBe(false);
  });

  it("checkIpBlock rejects blocked IPs with 429 IP_BLOCKED + Retry-After", async () => {
    const app = Fastify({ logger: false });
    const service = new IpBlockService(null, {
      failureThreshold: 1,
      failureWindowSeconds: 600,
      blockTtlSeconds: 42,
    });
    app.decorate("ipBlockService", service);
    // Minimal equivalent of the production error handler: domain errors keep
    // their status code and headers (Retry-After on 429s).
    app.setErrorHandler((error: unknown, _req, reply) => {
      const err = error as {
        statusCode?: number;
        code?: string;
        message?: string;
        headers?: Record<string, string>;
      };
      if (err?.headers) {
        for (const [header, value] of Object.entries(err.headers)) {
          reply.header(header, value);
        }
      }
      void reply
        .status(err?.statusCode ?? 500)
        .send({ error: { code: err?.code ?? "INTERNAL" } });
    });
    app.post(
      "/hook",
      { preHandler: [checkIpBlock] },
      async (_req, reply) => reply.status(200).send({ ok: true }),
    );

    await service.recordSignatureFailure("127.0.0.1", "STRIPE");

    const blockedRes = await app.inject({ method: "POST", url: "/hook", payload: {} });
    expect(blockedRes.statusCode).toBe(429);
    expect(blockedRes.json().error.code).toBe("IP_BLOCKED");
    expect(blockedRes.headers["retry-after"]).toBeDefined();

    await service.clearIpBlock("127.0.0.1");
    const okRes = await app.inject({ method: "POST", url: "/hook", payload: {} });
    expect(okRes.statusCode).toBe(200);

    await app.close();
  });
});

describe("abuse-limits: webhook signature failures trip IP block end-to-end", () => {
  let app: FastifyInstance;
  let adminApiKey: string;
  let viewerCookie: string;

  const runId = randomUUID().slice(0, 8);
  // TEST-NET-3 address: isolates this suite's abuse counters from every other
  // suite sharing the default inject IP (127.0.0.1).
  const ATTACKER_IP = "203.0.113.9";

  beforeAll(async () => {
    app = await buildApp({ eventBus: new NullBus() });
    await app.ready();

    const tenant = await createTenant(
      { db },
      { name: `Abuse Tenant ${runId}`, slug: `abuse-tenant-${runId}` },
    );

    const rawKey = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      { tenantId: tenant.id, keyHash: sha256Hex(rawKey), name: `abuse-key-${runId}`, scopes: ["*"] },
    );
    adminApiKey = rawKey;

    const viewer = await createUser(
      { db },
      {
        tenantId: tenant.id,
        email: `viewer_${runId}@example.com`,
        name: "Viewer",
        passwordHash: "dummy_hash",
        role: "VIEWER",
        status: "ACTIVE",
      },
    );
    const rawToken = randomUUID();
    await createSession(
      { db },
      {
        userId: viewer.id,
        tokenHash: sha256Hex(rawToken),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    );
    viewerCookie = rawToken;

    // Start from a clean slate for the suite IP (shared Redis across suites).
    await app.ipBlockService.clearIpBlock(ATTACKER_IP);
  });

  afterAll(async () => {
    await app.ipBlockService.clearIpBlock(ATTACKER_IP).catch(() => {});
    await app.close();
  });

  const badStripeSig = () =>
    app.inject({
      method: "POST",
      url: "/webhooks/stripe",
      remoteAddress: ATTACKER_IP,
      headers: {
        "content-type": "application/json",
        "stripe-signature": "t=123,v1=deadbeef",
      },
      payload: { id: `evt_${randomUUID().slice(0, 8)}`, type: "payment_intent.payment_failed" },
    });

  it("accumulates 401s then trips 429 IP_BLOCKED with Retry-After", async () => {
    let blockedAt = -1;
    for (let i = 0; i < 15; i++) {
      const res = await badStripeSig();
      if (res.statusCode === 429) {
        blockedAt = i;
        break;
      }
      expect(res.statusCode).toBe(401);
    }

    expect(blockedAt).toBeGreaterThanOrEqual(0);

    const blocked = await badStripeSig();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("IP_BLOCKED");
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("ADMIN can inspect and clear the block; VIEWER cannot", async () => {
    const listed = await app.inject({
      method: "GET",
      url: "/admin/ip-blocks",
      headers: { authorization: `Bearer ${adminApiKey}` },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().blocked.some((entry: { ip: string }) => entry.ip === ATTACKER_IP)).toBe(
      true,
    );

    const viewerClear = await app.inject({
      method: "DELETE",
      url: `/admin/ip-blocks/${ATTACKER_IP}`,
      headers: { cookie: `rr_session=${viewerCookie}` },
    });
    expect(viewerClear.statusCode).toBe(403);

    const cleared = await app.inject({
      method: "DELETE",
      url: `/admin/ip-blocks/${ATTACKER_IP}`,
      headers: { authorization: `Bearer ${adminApiKey}` },
    });
    expect(cleared.statusCode).toBe(204);

    const afterClear = await badStripeSig();
    expect(afterClear.statusCode).toBe(401);
  });
});
