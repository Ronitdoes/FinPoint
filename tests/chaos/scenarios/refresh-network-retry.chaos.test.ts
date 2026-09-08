/**
 * Chaos scenarios: browser refresh + network retry (Spec 01 §21).
 *
 * API-level analogues: a client retries POST /events with the same
 * Idempotency-Key after a refresh (sequential) or a network timeout
 * (concurrent duplicates). Acceptance: exactly one event row, every 202
 * echoes the same event id, and concurrent losers get 409 IN_FLIGHT
 * (retryable) — never a second row.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db, sql } from "@repo/db";
import { resetChaosHarness } from "../harness/fault-points";
import { assertInvariants } from "../harness/assert-invariants";
import { buildChaosApp, createChaosApiKey, createChaosTenant } from "../harness/seed";

describe("chaos: browser refresh + network retry", { timeout: 60000 }, () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildChaosApp());
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(() => {
    resetChaosHarness();
  });

  function eventBody(tenantId: string, entityId: string) {
    return {
      type: "payment.failed",
      tenant_id: tenantId,
      entity_type: "PAYMENT",
      entity_id: entityId,
      payload: { chaos: "refresh-retry" },
    };
  }

  it("sequential refresh with same Idempotency-Key → same event id, one row", async () => {
    const tenant = await createChaosTenant("refresh");
    const tenantId = tenant.id;
    const apiKey = await createChaosApiKey(tenantId);
    const key = `chaos-refresh-${randomUUID()}`;
    const entityId = `pay_refresh_${randomUUID().slice(0, 8)}`;
    const body = eventBody(tenantId, entityId);

    const first = await app.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": key },
      payload: body,
    });
    expect(first.statusCode).toBe(202);
    const firstId = (first.json() as { eventId: string }).eventId;

    // Browser refresh: identical retry returns the stored snapshot.
    const second = await app.inject({
      method: "POST",
      url: "/events",
      headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": key },
      payload: body,
    });
    expect(second.statusCode).toBe(202);
    expect((second.json() as { eventId: string }).eventId).toBe(firstId);

    const rows = await db.execute(
      sql`SELECT id FROM events WHERE tenant_id = ${tenantId} AND entity_id = ${entityId}`,
    );
    expect(rows.length).toBe(1);

    await assertInvariants(tenantId);
  });

  it("concurrent network retries ×10 → one row, 202-same-id or 409-retryable", async () => {
    const tenant = await createChaosTenant("netretry");
    const tenantId = tenant.id;
    const apiKey = await createChaosApiKey(tenantId);
    const key = `chaos-netretry-${randomUUID()}`;
    const entityId = `pay_netretry_${randomUUID().slice(0, 8)}`;
    const body = eventBody(tenantId, entityId);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.inject({
          method: "POST",
          url: "/events",
          headers: { authorization: `Bearer ${apiKey}`, "idempotency-key": key },
          payload: body,
        }),
      ),
    );

    const accepted = responses.filter((r) => r.statusCode === 202);
    const inFlight = responses.filter((r) => r.statusCode === 409);
    expect(accepted.length + inFlight.length).toBe(10);
    expect(accepted.length).toBeGreaterThanOrEqual(1);

    const ids = new Set(
      accepted.map((r) => (r.json() as { eventId: string }).eventId),
    );
    expect(ids.size).toBe(1);

    const rows = await db.execute(
      sql`SELECT id FROM events WHERE tenant_id = ${tenantId} AND entity_id = ${entityId}`,
    );
    expect(rows.length).toBe(1);

    await assertInvariants(tenantId);
  });
});
