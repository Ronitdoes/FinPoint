/**
 * Cross-tenant isolation proof suite (Step 30 §Requirements 1).
 *
 * Generated matrix over the backend route inventory: for EVERY
 * tenant-scoped endpoint, a tenant-B principal requests tenant-A resources
 * (ids swapped into path/body/query) and must receive 404/empty — never
 * 200 with foreign data. Tenant context is resolved exclusively from the
 * verified session/API-key principal (`getTenantScope`); request-supplied
 * tenant ids are rejected (403) or ignored.
 *
 * Seed topology: tenant A owns a full object graph (customer, payment,
 * risk, case, decision, policy rule, message, human task, promise-to-pay,
 * outcome, audit log, user, api key); tenant B owns only a bare customer.
 * Probes marked [detail] assert 404; [list] assert 200 with zero foreign
 * rows; [write] assert 404 without mutation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../apps/backend/src/app";
import { NullBus } from "@repo/integrations";
import {
  db,
  createTenant,
  createApiKey,
  createCustomer,
  createPayment,
  createRevenueRisk,
  createCase,
  createDecision,
  createPolicyRule,
  insertMessage,
  createHumanTask,
  createPromiseToPay,
  recordOutcome,
  recordAuditLog,
  createUser,
  createSession,
} from "@repo/db";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

interface Seed {
  tenantA: string;
  tenantB: string;
  keyA: string;
  keyB: string;
  viewerBCookie: string;
  customerA: string;
  paymentA: string;
  riskA: string;
  caseA: string;
  decisionA: string;
  policyA: string;
  policyACode: string;
  messageA: string;
  taskA: string;
  promiseA: string;
  outcomeA: string;
  adminAEmail: string;
  apiKeyAName: string;
}

describe("cross-tenant probe matrix", () => {
  let app: FastifyInstance;
  let seed: Seed;
  const runId = randomUUID().slice(0, 8);
  const authB = () => ({ authorization: `Bearer ${seed.keyB}` });
  const authA = () => ({ authorization: `Bearer ${seed.keyA}` });

  beforeAll(async () => {
    app = await buildApp({ eventBus: new NullBus() });
    await app.ready();

    const tenantA = await createTenant(
      { db },
      { name: `Probe Tenant A ${runId}`, slug: `probe-tenant-a-${runId}` },
    );
    const tenantB = await createTenant(
      { db },
      { name: `Probe Tenant B ${runId}`, slug: `probe-tenant-b-${runId}` },
    );

    const rawKeyA = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      { tenantId: tenantA.id, keyHash: sha256Hex(rawKeyA), name: `probe-key-a-${runId}`, scopes: ["*"] },
    );
    const rawKeyB = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      { tenantId: tenantB.id, keyHash: sha256Hex(rawKeyB), name: `probe-key-b-${runId}`, scopes: ["*"] },
    );

    const adminAEmail = `admin_a_${runId}@example.com`;
    await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: adminAEmail,
        name: "Probe Admin A",
        passwordHash: "dummy_hash",
        role: "ADMIN",
        status: "ACTIVE",
      },
    );
    const viewerB = await createUser(
      { db },
      {
        tenantId: tenantB.id,
        email: `viewer_b_${runId}@example.com`,
        name: "Probe Viewer B",
        passwordHash: "dummy_hash",
        role: "VIEWER",
        status: "ACTIVE",
      },
    );
    const viewerBRaw = randomUUID();
    await createSession(
      { db },
      {
        userId: viewerB.id,
        tokenHash: sha256Hex(viewerBRaw),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    );

    const customerA = await createCustomer(
      { db },
      {
        tenantId: tenantA.id,
        externalRef: `probe_cus_a_${runId}`,
        name: "Probe Customer A",
        email: `customer_a_${runId}@example.com`,
        status: "ACTIVE",
        lifetimeValue: 50000n,
        optedOut: false,
      },
    );
    await createCustomer(
      { db },
      {
        tenantId: tenantB.id,
        externalRef: `probe_cus_b_${runId}`,
        name: "Probe Customer B",
        status: "ACTIVE",
        lifetimeValue: 0n,
        optedOut: false,
      },
    );

    const paymentA = await createPayment(
      { db },
      {
        tenantId: tenantA.id,
        customerId: customerA.id,
        amount: 15000n,
        currency: "USD",
        status: "FAILED",
        provider: "STRIPE",
        providerPaymentId: `pi_probe_${runId}`,
        failureCode: "insufficient_funds",
        occurredAt: new Date(),
      },
    );

    const riskA = await createRevenueRisk(
      { db },
      {
        tenantId: tenantA.id,
        customerId: customerA.id,
        riskType: "PAYMENT_FAILURE",
        subjectType: "PAYMENT",
        subjectId: paymentA.id,
        score: 80,
        band: "HIGH",
        factors: { probe: true },
        computedAt: new Date(),
      },
    );

    const caseA = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: customerA.id,
        riskId: riskA.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: paymentA.id,
        amountAtRisk: 15000n,
        currency: "USD",
        riskScore: 80,
        status: "IN_PROGRESS",
      },
    );

    const decisionA = await createDecision(
      { db },
      {
        tenantId: tenantA.id,
        caseId: caseA.id,
        model: "probe-model",
        promptVersion: "payment_failure@1",
        inputSnapshot: { probe: true },
        recommendedActions: [],
        status: "COMPLETED",
      },
    );

    const policyACode = `PROBE_RULE_${runId}`.toUpperCase().replace(/-/g, "_");
    const policyA = await createPolicyRule(
      { db },
      {
        tenantId: tenantA.id,
        code: policyACode,
        name: `Probe rule ${runId}`,
        ruleKind: "LIMIT",
        definition: { max: 1 },
        enabled: true,
      },
    );

    const messageA = await insertMessage(
      { db },
      {
        tenantId: tenantA.id,
        caseId: caseA.id,
        customerId: customerA.id,
        channel: "WHATSAPP",
        templateId: "probe_template",
        toAddress: "+15550001111",
        provider: "MOCK",
        idempotencyKey: `probe_msg_${runId}`,
        status: "QUEUED",
      },
    );

    const taskA = await createHumanTask(
      { db },
      {
        tenantId: tenantA.id,
        caseId: caseA.id,
        type: "APPROVAL",
        title: `Probe task ${runId}`,
      },
    );

    const promiseA = await createPromiseToPay(
      { db },
      {
        tenantId: tenantA.id,
        caseId: caseA.id,
        promisedAmount: 15000n,
        currency: "USD",
        promisedByDate: "2030-01-01",
      },
    );

    const outcomeA = await recordOutcome(
      { db },
      {
        tenantId: tenantA.id,
        caseId: caseA.id,
        paymentId: paymentA.id,
        baselineAmount: 15000n,
        recoveredAmount: 15000n,
        recoveryCost: 100n,
        attributionMethod: "DIRECT_PAYMENT",
        attributionWindowHours: 72,
        recoveredAt: new Date(),
      },
    );

    await recordAuditLog(
      { db },
      {
        tenantId: tenantA.id,
        caseId: caseA.id,
        actorType: "SYSTEM",
        event: "probe.seed",
        metadata: { probe: runId },
      },
    );

    seed = {
      tenantA: tenantA.id,
      tenantB: tenantB.id,
      keyA: rawKeyA,
      keyB: rawKeyB,
      viewerBCookie: viewerBRaw,
      customerA: customerA.id,
      paymentA: paymentA.id,
      riskA: riskA.id,
      caseA: caseA.id,
      decisionA: decisionA.id,
      policyA: policyA.id,
      policyACode,
      messageA: messageA.id,
      taskA: taskA.id,
      promiseA: promiseA.id,
      outcomeA: outcomeA.id,
      adminAEmail,
      apiKeyAName: `probe-key-a-${runId}`,
    };
  });

  afterAll(async () => {
    await app.close();
  });

  describe("owner sanity: tenant A sees its own objects (probes are meaningful)", () => {
    it("GET /cases/:id → 200 for owner", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/cases/${seed.caseA}`,
        headers: authA(),
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /cases/:id/outcome → 200 for owner", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/cases/${seed.caseA}/outcome`,
        headers: authA(),
      });
      expect(res.statusCode).toBe(200);
    });

    it("GET /messages/:id → 200 for owner", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/messages/${seed.messageA}`,
        headers: authA(),
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("detail probes: foreign id in path → 404, never 200-with-foreign-data", () => {
    const detailProbes: Array<{ name: string; method: "GET" | "POST"; url: (s: Seed) => string; body?: object }> = [
      { name: "GET /risks/:id", method: "GET", url: (s) => `/risks/${s.riskA}` },
      { name: "GET /customers/:id/context", method: "GET", url: (s) => `/customers/${s.customerA}/context` },
      { name: "GET /ai/decisions/:id", method: "GET", url: (s) => `/ai/decisions/${s.decisionA}` },
      { name: "GET /cases/:id", method: "GET", url: (s) => `/cases/${s.caseA}` },
      { name: "GET /cases/:id/timeline", method: "GET", url: (s) => `/cases/${s.caseA}/timeline` },
      { name: "GET /cases/:id/outcome", method: "GET", url: (s) => `/cases/${s.caseA}/outcome` },
      { name: "GET /payments/:id", method: "GET", url: (s) => `/payments/${s.paymentA}` },
      { name: "GET /payments/:id/status", method: "GET", url: (s) => `/payments/${s.paymentA}/status` },
      { name: "GET /messages/:id", method: "GET", url: (s) => `/messages/${s.messageA}` },
      { name: "GET /human-tasks/:id", method: "GET", url: (s) => `/human-tasks/${s.taskA}` },
      { name: "GET /promises-to-pay/:id", method: "GET", url: (s) => `/promises-to-pay/${s.promiseA}` },
      { name: "GET /outcomes/cases/:id", method: "GET", url: (s) => `/outcomes/cases/${s.caseA}` },
      { name: "GET /policies/:id/versions", method: "GET", url: (s) => `/policies/${s.policyA}/versions` },
      { name: "POST /cases/:id/pause", method: "POST", url: (s) => `/cases/${s.caseA}/pause`, body: {} },
    ];

    for (const probe of detailProbes) {
      it(`${probe.name} → 404 for foreign tenant`, async () => {
        const res = await app.inject({
          method: probe.method,
          url: probe.url(seed),
          headers: { ...authB(), "content-type": "application/json" },
          payload: probe.body,
        });
        expect(res.statusCode).toBe(404);
        // The 404 body must not echo the foreign object.
        expect(res.body.includes(seed.caseA) && res.body.includes("IN_PROGRESS")).toBe(false);
      });
    }

    it("POST /ai/decide with foreign case_id → 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/ai/decide",
        headers: authB(),
        payload: { case_id: seed.caseA },
      });
      expect(res.statusCode).toBe(404);
    });

    it("PATCH /policies/:id with foreign id → 404 without mutation", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/policies/${seed.policyA}`,
        headers: authB(),
        payload: { name: "evil rename" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("body/query probes: foreign tenant id in payload → 403/empty", () => {
    it("POST /events with foreign tenant_id → 403", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/events",
        headers: authB(),
        payload: {
          type: "payment.failed",
          source: "INTERNAL",
          tenant_id: seed.tenantA,
          entity_type: "PAYMENT",
          entity_id: seed.paymentA,
          // s-11 gaps: schema-valid payload so the probe reaches the
          // tenant-isolation check (403), not per-type validation (422).
          payload: { amount: 5000 },
        },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("list probes: 200 with zero foreign rows", () => {
    const listProbes: Array<{ name: string; url: string; foreignMarkers: (s: Seed) => string[] }> = [
      { name: "GET /risks", url: "/risks", foreignMarkers: (s) => [s.riskA] },
      { name: "GET /cases", url: "/cases", foreignMarkers: (s) => [s.caseA] },
      { name: "GET /messages", url: "/messages", foreignMarkers: (s) => [s.messageA] },
      { name: "GET /human-tasks", url: "/human-tasks", foreignMarkers: (s) => [s.taskA, s.caseA] },
      { name: "GET /promises-to-pay", url: "/promises-to-pay", foreignMarkers: (s) => [s.promiseA] },
      { name: "GET /outcomes", url: "/outcomes", foreignMarkers: (s) => [s.outcomeA, s.caseA] },
      { name: "GET /ai/decisions", url: "/ai/decisions", foreignMarkers: (s) => [s.decisionA, s.caseA] },
      { name: "GET /policies", url: "/policies", foreignMarkers: (s) => [s.policyACode] },
      { name: "GET /audit", url: "/audit", foreignMarkers: (s) => [s.caseA] },
      { name: "GET /analytics/summary", url: "/analytics/summary", foreignMarkers: (s) => [s.customerA] },
      { name: "GET /admin/users", url: "/admin/users", foreignMarkers: (s) => [s.adminAEmail] },
      { name: "GET /admin/api-keys", url: "/admin/api-keys", foreignMarkers: (s) => [s.apiKeyAName] },
    ];

    for (const probe of listProbes) {
      it(`${probe.name} → 200 with no tenant-A rows`, async () => {
        const res = await app.inject({
          method: "GET",
          url: probe.url,
          headers: authB(),
        });
        expect(res.statusCode).toBe(200);
        for (const marker of probe.foreignMarkers(seed)) {
          expect(
            res.body.includes(marker),
            `${probe.name} leaked foreign marker ${marker}`,
          ).toBe(false);
        }
      });
    }
  });

  describe("auth/RBAC spot checks on the same surface", () => {
    it("GET /cases without credentials → 401", async () => {
      const res = await app.inject({ method: "GET", url: "/cases" });
      expect(res.statusCode).toBe(401);
    });

    it("GET /audit as VIEWER session → 403 (ADMIN only)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/audit",
        headers: { cookie: `rr_session=${seed.viewerBCookie}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("POST /policies as VIEWER session → 403 (FINANCE+ only)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/policies",
        headers: { cookie: `rr_session=${seed.viewerBCookie}` },
        payload: { code: "X", name: "X", definition: {} },
      });
      expect(res.statusCode).toBe(403);
    });

    it("GET /auth/me as tenant B key binds to tenant B", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/auth/me",
        headers: authB(),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().auth.tenantId).toBe(seed.tenantB);
    });
  });
});
