/**
 * Chaos scenario: Redis unavailable (Spec 01 §21).
 *
 * Acceptance: degraded-not-dead behavior — reads/writes keep serving from
 * PostgreSQL, injection switches fall back to env defaults, and recovery is
 * automatic when Redis returns. The container-restart half runs nightly via
 * the compose drill (skipped here with a report artifact).
 */
import { describe, it, expect, afterEach } from "vitest";
import Redis from "ioredis";
import { getDemoInjections } from "../../../apps/backend/src/modules/demo/injections";
import { assertNonProd, drillRestartRedis } from "../harness/compose-admin";
import { resetChaosHarness } from "../harness/fault-points";
import { buildChaosApp, createChaosApiKey, createChaosTenant } from "../harness/seed";

describe("chaos: Redis unavailable", { timeout: 60000 }, () => {
  afterEach(() => {
    resetChaosHarness();
  });

  it("degraded-not-dead: app serves traffic with no Redis client", async () => {
    const { app } = await buildChaosApp();
    // Force degraded mode even if a local Redis is reachable.
    (app as any).redisClient = null;
    try {
      const tenant = await createChaosTenant("redisdown");
      const apiKey = await createChaosApiKey(tenant.id);

      const health = await app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);

      const res = await app.inject({
        method: "POST",
        url: "/events",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "idempotency-key": `chaos-redis-${tenant.id}`,
        },
        payload: {
          type: "payment.failed",
          tenant_id: tenant.id,
          entity_type: "PAYMENT",
          entity_id: `pay_chaos_${tenant.id.slice(0, 8)}`,
          payload: { chaos: true },
        },
      });
      expect([200, 202]).toContain(res.statusCode);
    } finally {
      await app.close();
    }
  });

  it("injection switches fall back to env defaults when Redis is unreachable", async () => {
    const lazy = new Redis({
      host: "127.0.0.1",
      port: 6399,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    try {
      const resolved = await getDemoInjections(lazy, null);
      expect(resolved.source).toBe("fallback");
      expect(resolved.injections.simulate_payment_timeout).toBe(false);
    } finally {
      lazy.disconnect();
    }

    const none = await getDemoInjections(null, null);
    expect(none.source).toBe("fallback");
  });

  it("compose restart drill is admin-guarded and skipped without CHAOS_INFRA", () => {
    expect(() => assertNonProd()).not.toThrow();
    const report = drillRestartRedis();
    expect(report.drill).toBe("redis-down");
    expect(report.skipped).toBe(true);
    expect(report.skipReason).toMatch(/CHAOS_INFRA/);
  });
});
