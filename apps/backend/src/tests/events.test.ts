import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { NullBus } from "@repo/integrations";
import {
  db,
  sql,
  createTenant,
  createUser,
  createApiKey,
  events,
  auditLogs,
  eq,
} from "@repo/db";
import { hashPassword, sha256 } from "../lib/crypto";

describe("Step 11 Integration: Internal Event Bus & Replay (/events)", { timeout: 30000 }, () => {
  let app: FastifyInstance;
  let eventBus: NullBus;
  let tenantId: string;
  let otherTenantId: string;
  let apiKeyWithEventsWrite: string;
  let apiKeyWithoutScope: string;
  let operationsUserCookie: string;
  let viewerUserCookie: string;
  let operationsUserId: string;

  const runId = randomUUID().slice(0, 8);

  beforeAll(async () => {
    eventBus = new NullBus();

    // 1. Create main test tenant
    const tenant = await createTenant(
      { db },
      {
        name: `Events Test Tenant ${runId}`,
        slug: `events-tenant-${runId}`,
      },
    );
    tenantId = tenant.id;

    // 2. Create another tenant for cross-tenant rejection tests
    const otherTenant = await createTenant(
      { db },
      {
        name: `Other Test Tenant ${runId}`,
        slug: `other-tenant-${runId}`,
      },
    );
    otherTenantId = otherTenant.id;

    // 3. Create machine API keys for tenant
    const rawKey1 = `rrk_${randomUUID().replace(/-/g, "")}`;
    const keyHash1 = sha256(rawKey1);
    await createApiKey(
      { db },
      {
        tenantId,
        name: "Events Write Key",
        keyHash: keyHash1,
        scopes: ["events:write"],
      },
    );
    apiKeyWithEventsWrite = rawKey1;

    const rawKey2 = `rrk_${randomUUID().replace(/-/g, "")}`;
    const keyHash2 = sha256(rawKey2);
    await createApiKey(
      { db },
      {
        tenantId,
        name: "Read Only Key",
        keyHash: keyHash2,
        scopes: ["cases:read"],
      },
    );
    apiKeyWithoutScope = rawKey2;

    // 4. Create OPERATIONS user and VIEWER user
    const passwordHash = await hashPassword("SecurePass123!@#");
    const opUser = await createUser(
      { db },
      {
        tenantId,
        email: `operator-${runId}@example.com`,
        name: "Test Operator",
        role: "OPERATIONS",
        passwordHash,
        status: "ACTIVE",
      },
    );
    operationsUserId = opUser.id;

    const viewerUser = await createUser(
      { db },
      {
        tenantId,
        email: `viewer-${runId}@example.com`,
        name: "Test Viewer",
        role: "VIEWER",
        passwordHash,
        status: "ACTIVE",
      },
    );

    // 5. Build fastify application instance with injected EventBus
    app = await buildApp({
      eventBus,
      disableRateLimit: true,
      logger: false,
    });
    await app.ready();

    // 6. Login to obtain session cookies
    const opLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: `operator-${runId}@example.com`,
        password: "SecurePass123!@#",
      },
    });
    const opMatch = String(opLogin.headers["set-cookie"]).match(/rr_session=([^;]+)/);
    operationsUserCookie = `rr_session=${opMatch![1]}`;

    const viewerLogin = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: {
        email: `viewer-${runId}@example.com`,
        password: "SecurePass123!@#",
      },
    });
    const viewerMatch = String(viewerLogin.headers["set-cookie"]).match(/rr_session=([^;]+)/);
    viewerUserCookie = `rr_session=${viewerMatch![1]}`;
  }, 45000);

  beforeEach(() => {
    eventBus.clearPublished();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe("POST /events (Internal Ingestion)", () => {
    it("1. Valid internal event -> 202 ACCEPTED, stored as INTERNAL/PROCESSED, published to EventBus", async () => {
      const checkoutId = `chk_${randomUUID()}`;
      const customerId = `cus_${randomUUID()}`;

      const res = await app.inject({
        method: "POST",
        url: "/events",
        headers: {
          authorization: `Bearer ${apiKeyWithEventsWrite}`,
          "content-type": "application/json",
        },
        payload: {
          type: "checkout.started",
          tenant_id: tenantId,
          customer_id: customerId,
          entity_type: "CHECKOUT",
          entity_id: checkoutId,
          payload: {
            cart_total: 12000,
            currency: "USD",
            items: [{ id: "item_1", name: "Pro Subscription", price: 12000 }],
          },
        },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.eventId).toBeDefined();

      // Verify row persisted in database
      const [storedEvent] = await db
        .select()
        .from(events)
        .where(eq(events.id, body.eventId));

      expect(storedEvent).toBeDefined();
      expect(storedEvent.source).toBe("INTERNAL");
      expect(storedEvent.type).toBe("checkout.started");
      expect(storedEvent.status).toBe("PROCESSED");
      expect(storedEvent.tenantId).toBe(tenantId);
      expect(storedEvent.entityId).toBe(checkoutId);

      // Verify event was dispatched onto EventBus
      expect(eventBus.published.length).toBe(1);
      expect(eventBus.published[0].id).toBe(body.eventId);
      expect(eventBus.published[0].type).toBe("checkout.started");
      expect(eventBus.published[0].tenant_id).toBe(tenantId);
    }, 30000);

    it("2. Missing authentication -> 401 UNAUTHENTICATED", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/events",
        headers: {
          "content-type": "application/json",
        },
        payload: {
          type: "checkout.started",
          tenant_id: tenantId,
          entity_id: "chk_123",
          payload: {},
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    }, 30000);

    it("3. API key without events:write scope -> 403 FORBIDDEN", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/events",
        headers: {
          authorization: `Bearer ${apiKeyWithoutScope}`,
          "content-type": "application/json",
        },
        payload: {
          type: "checkout.started",
          tenant_id: tenantId,
          entity_id: "chk_123",
          payload: {},
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    }, 30000);

    it("4. Cross-tenant mismatch (body.tenant_id != key.tenantId) -> 403 FORBIDDEN", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/events",
        headers: {
          authorization: `Bearer ${apiKeyWithEventsWrite}`,
          "content-type": "application/json",
        },
        payload: {
          type: "checkout.started",
          tenant_id: otherTenantId, // Mismatch!
          entity_id: "chk_cross_tenant",
          // s-11 gaps: schema-valid payload so the request reaches the
          // tenant-isolation check (not 422 per-type validation).
          payload: { cart_total: 1000, currency: "USD" },
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    }, 30000);

    it("5. Schema validation failure (invalid event type) -> 422 VALIDATION", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/events",
        headers: {
          authorization: `Bearer ${apiKeyWithEventsWrite}`,
          "content-type": "application/json",
        },
        payload: {
          type: "invalid.nonexistent.event.type",
          tenant_id: tenantId,
          entity_id: "chk_bad",
          payload: {},
        },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("VALIDATION");
    }, 30000);

    it("5b. Per-type payload violations -> 422 VALIDATION (s-11 gaps)", async () => {
      const violations = [
        {
          type: "payment.failed",
          entity_type: "PAYMENT",
          entity_id: `pay_empty_${randomUUID()}`,
          payload: {},
        },
        {
          type: "payment.failed",
          entity_type: "PAYMENT",
          entity_id: `pay_wrongtype_${randomUUID()}`,
          payload: { amount: "not-a-number", currency: 12345 },
        },
        {
          type: "invoice.overdue",
          entity_type: "INVOICE",
          entity_id: `in_empty_${randomUUID()}`,
          payload: {},
        },
        {
          type: "checkout.started",
          entity_type: "CHECKOUT",
          entity_id: `chk_empty_${randomUUID()}`,
          payload: {},
        },
      ];

      for (const body of violations) {
        const res = await app.inject({
          method: "POST",
          url: "/events",
          headers: {
            authorization: `Bearer ${apiKeyWithEventsWrite}`,
            "content-type": "application/json",
          },
          payload: { ...body, tenant_id: tenantId },
        });

        expect(res.statusCode, JSON.stringify(body)).toBe(422);
        expect(res.json().error.code).toBe("VALIDATION");
      }
    }, 30000);

    it("6. Idempotency-Key reuse: same payload returns 202 snapshot; different payload returns 409 IDEMPOTENCY_KEY_REUSED", async () => {
      const idempotencyKey = `idem_key_${randomUUID()}`;
      const payloadA = {
        type: "payment.failed",
        tenant_id: tenantId,
        entity_type: "PAYMENT",
        entity_id: `pay_${randomUUID()}`,
        payload: { amount: 5000, reason: "card_declined" },
      };

      // 1st request with key
      const res1 = await app.inject({
        method: "POST",
        url: "/events",
        headers: {
          authorization: `Bearer ${apiKeyWithEventsWrite}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        payload: payloadA,
      });

      expect(res1.statusCode).toBe(202);
      const eventId1 = res1.json().eventId;
      expect(eventId1).toBeDefined();

      // 2nd request with same key and SAME payload -> returns cached 202 with same eventId
      const res2 = await app.inject({
        method: "POST",
        url: "/events",
        headers: {
          authorization: `Bearer ${apiKeyWithEventsWrite}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        payload: payloadA,
      });

      expect(res2.statusCode).toBe(202);
      expect(res2.json().eventId).toBe(eventId1);

      // 3rd request with same key and DIFFERENT payload -> 409 IDEMPOTENCY_KEY_REUSED
      const payloadB = {
        ...payloadA,
        payload: { amount: 99999, reason: "different_reason" },
      };

      const res3 = await app.inject({
        method: "POST",
        url: "/events",
        headers: {
          authorization: `Bearer ${apiKeyWithEventsWrite}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        payload: payloadB,
      });

      expect(res3.statusCode).toBe(409);
      expect(res3.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    }, 30000);
  });

  describe("POST /events/replay", () => {
    let originalEventId: string;

    beforeAll(async () => {
      // Ingest an event to replay
      const res = await app.inject({
        method: "POST",
        url: "/events",
        headers: {
          authorization: `Bearer ${apiKeyWithEventsWrite}`,
          "content-type": "application/json",
        },
        payload: {
          type: "payment.failed",
          tenant_id: tenantId,
          entity_type: "PAYMENT",
          entity_id: `pay_orig_${randomUUID()}`,
          payload: { amount: 15000, reason: "expired_card" },
        },
      });
      originalEventId = res.json().eventId;
    }, 30000);

    it("1. Replay by eventId (as OPERATIONS) -> 202 ACCEPTED, new row referencing original created, published, audit log written", async () => {
      eventBus.clearPublished();

      const res = await app.inject({
        method: "POST",
        url: "/events/replay",
        headers: {
          cookie: operationsUserCookie,
          "content-type": "application/json",
        },
        payload: {
          eventId: originalEventId,
        },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.queued).toBe(1);
      expect(body.replayIds.length).toBe(1);
      const replayedEventId = body.replayIds[0];
      expect(replayedEventId).not.toBe(originalEventId);

      // Verify replayed event row exists in DB
      const [replayedRow] = await db
        .select()
        .from(events)
        .where(eq(events.id, replayedEventId));

      expect(replayedRow).toBeDefined();
      expect(replayedRow.status).toBe("PROCESSED");
      expect((replayedRow.payload as any).replayed_from).toBe(originalEventId);

      // Verify event was re-published to EventBus
      expect(eventBus.published.length).toBe(1);
      expect(eventBus.published[0].id).toBe(replayedEventId);
      expect(eventBus.published[0].type).toBe("payment.failed");

      // Verify audit_logs entry was written
      const auditEntries = await db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.tenantId, tenantId));

      const replayAudit = auditEntries.find((a) => a.event === "events.replayed");
      expect(replayAudit).toBeDefined();
      expect(replayAudit?.actorType).toBe("USER");
      expect((replayAudit?.metadata as any).queued).toBe(1);
      expect((replayAudit?.metadata as any).eventId).toBe(originalEventId);
    }, 30000);

    it("2. Replay by filter -> 202 ACCEPTED with multiple replayed events", async () => {
      eventBus.clearPublished();

      const res = await app.inject({
        method: "POST",
        url: "/events/replay",
        headers: {
          cookie: operationsUserCookie,
          "content-type": "application/json",
        },
        payload: {
          filter: {
            type: "payment.failed",
          },
          limit: 10,
        },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.queued).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(body.replayIds)).toBe(true);
      expect(eventBus.published.length).toBe(body.queued);
    }, 30000);

    it("3. Replay with non-existent eventId -> 404 NOT_FOUND", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/events/replay",
        headers: {
          cookie: operationsUserCookie,
          "content-type": "application/json",
        },
        payload: {
          eventId: randomUUID(),
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    }, 30000);

    it("4. Replay as VIEWER -> 403 FORBIDDEN", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/events/replay",
        headers: {
          cookie: viewerUserCookie,
          "content-type": "application/json",
        },
        payload: {
          eventId: originalEventId,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    }, 30000);

    it("5. Replaying the same event twice yields two distinct rows (fresh UUID per replay, no externalEventId anchor)", async () => {
      const replayOnce = async () => {
        const res = await app.inject({
          method: "POST",
          url: "/events/replay",
          headers: {
            cookie: operationsUserCookie,
            "content-type": "application/json",
          },
          payload: {
            eventId: originalEventId,
          },
        });
        expect(res.statusCode).toBe(202);
        return res.json().replayIds[0] as string;
      };

      const firstReplayId = await replayOnce();
      const secondReplayId = await replayOnce();

      // Each replay inserts a fresh row: replays carry no externalEventId, so
      // insertEventIfNew always generates a new UUID (never dedupes).
      expect(firstReplayId).not.toBe(originalEventId);
      expect(secondReplayId).not.toBe(originalEventId);
      expect(secondReplayId).not.toBe(firstReplayId);

      for (const replayId of [firstReplayId, secondReplayId]) {
        const [row] = await db
          .select()
          .from(events)
          .where(eq(events.id, replayId));
        expect(row).toBeDefined();
        expect(row.status).toBe("PROCESSED");
        expect((row.payload as any).replayed_from).toBe(originalEventId);
      }
    }, 30000);
  });
});
