import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { NullBus } from "@repo/integrations";
import {
  db,
  createTenant,
  createApiKey,
  createCustomer,
  createPayment,
  createInvoice,
  createCheckout,
  revenueRisks,
  eq,
} from "@repo/db";
import { sha256 } from "../lib/crypto";
import type { DomainEvent } from "@repo/domain";
import { scorePaymentFailure } from "../modules/risk/engine/score-payment-failure";
import type { SubjectAggregates } from "../modules/risk/risk.types";

describe("Step 12 Integration: Risk Engine v1 (Deterministic Scoring)", { timeout: 45000 }, () => {
  let app: FastifyInstance;
  let eventBus: NullBus;
  let tenantAId: string;
  let tenantBId: string;
  let tenantAApiKey: string;
  let tenantBApiKey: string;
  let customerAId: string;
  let customerBId: string;
  let customerCheckoutId: string;
  let customerInvoiceId: string;

  const runId = randomUUID().slice(0, 8);

  beforeAll(async () => {
    eventBus = new NullBus();

    // 1. Create Tenant A & Tenant B
    const tenantA = await createTenant(
      { db },
      {
        name: `Risk Tenant A ${runId}`,
        slug: `risk-tenant-a-${runId}`,
      },
    );
    tenantAId = tenantA.id;

    const tenantB = await createTenant(
      { db },
      {
        name: `Risk Tenant B ${runId}`,
        slug: `risk-tenant-b-${runId}`,
      },
    );
    tenantBId = tenantB.id;

    // 2. Create API keys
    const rawKeyA = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId: tenantAId,
        name: "Tenant A Risk Key",
        keyHash: sha256(rawKeyA),
        scopes: ["events:write", "cases:read"],
      },
    );
    tenantAApiKey = rawKeyA;

    const rawKeyB = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId: tenantBId,
        name: "Tenant B Risk Key",
        keyHash: sha256(rawKeyB),
        scopes: ["events:write", "cases:read"],
      },
    );
    tenantBApiKey = rawKeyB;

    // 3. Create test customers
    const customerA = await createCustomer(
      { db },
      {
        tenantId: tenantAId,
        name: "Customer Alpha",
        email: `alpha-${runId}@example.com`,
        status: "ACTIVE",
      },
    );
    customerAId = customerA.id;

    const customerB = await createCustomer(
      { db },
      {
        tenantId: tenantBId,
        name: "Customer Beta",
        email: `beta-${runId}@example.com`,
        status: "ACTIVE",
      },
    );
    customerBId = customerB.id;

    const custCheckout = await createCustomer(
      { db },
      {
        tenantId: tenantAId,
        name: "Customer Checkout Isolated",
        email: `checkout-${runId}@example.com`,
        status: "ACTIVE",
      },
    );
    customerCheckoutId = custCheckout.id;

    const custInvoice = await createCustomer(
      { db },
      {
        tenantId: tenantAId,
        name: "Customer Invoice Isolated",
        email: `invoice-${runId}@example.com`,
        status: "ACTIVE",
      },
    );
    customerInvoiceId = custInvoice.id;

    // 4. Build application instance
    app = await buildApp({
      eventBus,
      disableRateLimit: true,
      logger: false,
    });
    await app.ready();
  }, 45000);

  beforeEach(() => {
    eventBus.clearPublished();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe("1. Payment Failure Trigger & Deterministic Scoring", () => {
    it("processes payment.failed event -> persists OPEN risk, computes factor breakdown & emits risk.calculated", async () => {
      // 1. Create a payment fixture for Tenant A (amount: ₹60,000 >= 50k threshold)
      const payment = await createPayment(
        { db },
        {
          tenantId: tenantAId,
          customerId: customerAId,
          amount: 6_000_000n, // 60,000 INR -> triggers amount_high (+10)
          currency: "INR",
          provider: "STRIPE",
          providerPaymentId: `pi_test_${randomUUID().slice(0, 8)}`,
          status: "FAILED",
          occurredAt: new Date(),
        },
      );

      const correlationId = randomUUID();
      const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

      const triggerEvent: DomainEvent = {
        id: randomUUID(),
        type: "payment.failed",
        occurred_at: new Date().toISOString(),
        source: "stripe",
        tenant_id: tenantAId,
        customer_id: customerAId,
        entity_id: payment.id,
        entity_type: "PAYMENT",
        payload: {
          payment_id: payment.id,
          amount: 6000000,
          currency: "INR",
        },
        correlation_id: correlationId,
        traceparent,
      };

      // Publish event onto bus (null bus dispatches synchronously to risk-engine subscriber)
      await app.eventBus.publish(triggerEvent);

      // Verify risk persisted in DB
      const openRisk = await app.repos.findLatestRiskForSubject(
        { db },
        {
          tenantId: tenantAId,
          subjectType: "PAYMENT",
          subjectId: payment.id,
        },
      );

      expect(openRisk).not.toBeNull();
      expect(openRisk!.status).toBe("OPEN");
      expect(openRisk!.riskType).toBe("PAYMENT_FAILURE");
      // score: payment_failed_1 (+20) + amount_high (+10) + customer_active (+10) = 40 (MEDIUM)
      expect(openRisk!.score).toBe(40);
      expect(openRisk!.band).toBe("MEDIUM");

      // Verify factor explainability persisted in JSONB
      const factors: any = openRisk!.factors;
      expect(factors.rules).toBeDefined();
      expect(Array.isArray(factors.rules)).toBe(true);
      expect(factors.breakdown).toBeDefined();
      expect(factors.breakdown.payment_failed_count_gte_1).toBe(20);
      expect(factors.breakdown.amount_high).toBe(10);
      expect(factors.breakdown.customer_active).toBe(10);

      // Verify internal domain event risk.calculated was emitted onto the bus
      const emittedEvents = eventBus.published.filter(
        (e) => e.type === "risk.calculated",
      );
      expect(emittedEvents.length).toBeGreaterThanOrEqual(1);

      const riskCalculated = emittedEvents[emittedEvents.length - 1];
      expect(riskCalculated.correlation_id).toBe(correlationId); // Correlation continuity
      expect(riskCalculated.traceparent).toBe(traceparent); // Trace continuity
      expect(riskCalculated.tenant_id).toBe(tenantAId);
      expect(riskCalculated.customer_id).toBe(customerAId);
      expect((riskCalculated.payload as any).riskId).toBe(openRisk!.id);
      expect((riskCalculated.payload as any).score).toBe(40);
      expect((riskCalculated.payload as any).band).toBe("MEDIUM");
    }, 30000);
  });

  describe("2. Idempotency & Redelivery Resilience", () => {
    it("handles duplicate event delivery idempotently without creating duplicate risk rows", async () => {
      const payment = await createPayment(
        { db },
        {
          tenantId: tenantAId,
          customerId: customerAId,
          amount: 1_000_000n, // 10,000 INR
          currency: "INR",
          provider: "STRIPE",
          providerPaymentId: `pi_dup_${randomUUID().slice(0, 8)}`,
          status: "FAILED",
          occurredAt: new Date(),
        },
      );

      const triggerEvent: DomainEvent = {
        id: randomUUID(),
        type: "payment.failed",
        occurred_at: new Date().toISOString(),
        source: "stripe",
        tenant_id: tenantAId,
        customer_id: customerAId,
        entity_id: payment.id,
        entity_type: "PAYMENT",
        payload: { payment_id: payment.id },
        correlation_id: randomUUID(),
      };

      // Deliver the same event 3 times
      await app.eventBus.publish(triggerEvent);
      await app.eventBus.publish(triggerEvent);
      await app.eventBus.publish(triggerEvent);

      // Verify exactly ONE risk row exists for this payment
      const risks = await db
        .select()
        .from(revenueRisks)
        .where(
          eq(revenueRisks.subjectId, payment.id),
        );

      expect(risks).toHaveLength(1);
      expect(risks[0].status).toBe("OPEN");
    }, 30000);
  });

  describe("3. Resolution Path: payment.succeeded / invoice.paid / checkout.completed", () => {
    it("payment.succeeded after failure -> marks OPEN risk as EXPIRED (resolved_upstream)", async () => {
      const payment = await createPayment(
        { db },
        {
          tenantId: tenantAId,
          customerId: customerAId,
          amount: 2_000_000n,
          currency: "INR",
          provider: "STRIPE",
          providerPaymentId: `pi_succ_${randomUUID().slice(0, 8)}`,
          status: "FAILED",
          occurredAt: new Date(),
        },
      );

      // 1. Send failure event -> creates OPEN risk
      await app.eventBus.publish({
        id: randomUUID(),
        type: "payment.failed",
        occurred_at: new Date().toISOString(),
        source: "stripe",
        tenant_id: tenantAId,
        customer_id: customerAId,
        entity_id: payment.id,
        entity_type: "PAYMENT",
        payload: { payment_id: payment.id },
        correlation_id: randomUUID(),
      });

      const openRiskBefore = await app.repos.findLatestRiskForSubject(
        { db },
        {
          tenantId: tenantAId,
          subjectType: "PAYMENT",
          subjectId: payment.id,
        },
      );
      expect(openRiskBefore?.status).toBe("OPEN");

      // 2. Send payment.succeeded event
      await app.eventBus.publish({
        id: randomUUID(),
        type: "payment.succeeded",
        occurred_at: new Date().toISOString(),
        source: "stripe",
        tenant_id: tenantAId,
        customer_id: customerAId,
        entity_id: payment.id,
        entity_type: "PAYMENT",
        payload: { payment_id: payment.id },
        correlation_id: randomUUID(),
      });

      // 3. Verify risk is now EXPIRED
      const closedRisk = await app.repos.findLatestRiskForSubject(
        { db },
        {
          tenantId: tenantAId,
          subjectType: "PAYMENT",
          subjectId: payment.id,
        },
      );
      expect(closedRisk?.status).toBe("EXPIRED");
      expect(closedRisk?.expiresAt).toBeDefined();
    }, 30000);
  });

  describe("4. Checkout Abandonment & Invoice Overdue Triggers", () => {
    it("checkout.abandoned -> creates OPEN risk for checkout", async () => {
      const checkout = await createCheckout(
        { db },
        {
          tenantId: tenantAId,
          customerId: customerCheckoutId,
          cartValue: 700_000n, // ₹7,000 (intent >= 5k)
          currency: "INR",
          status: "PAYMENT_STARTED",
          startedAt: new Date(),
          lastActivityAt: new Date(),
        },
      );

      await app.eventBus.publish({
        id: randomUUID(),
        type: "checkout.abandoned",
        occurred_at: new Date().toISOString(),
        source: "shopify",
        tenant_id: tenantAId,
        customer_id: customerCheckoutId,
        entity_id: checkout.id,
        entity_type: "CHECKOUT",
        payload: { checkout_id: checkout.id },
        correlation_id: randomUUID(),
      });

      const risk = await app.repos.findLatestRiskForSubject(
        { db },
        {
          tenantId: tenantAId,
          subjectType: "CHECKOUT",
          subjectId: checkout.id,
        },
      );

      expect(risk).not.toBeNull();
      expect(risk!.riskType).toBe("CHECKOUT_ABANDONMENT");
      expect(risk!.status).toBe("OPEN");
      // high_intent (+15) + customer_active (+10) = 25 (LOW)
      expect(risk!.score).toBe(25);
      expect(risk!.band).toBe("LOW");
    }, 30000);

    it("invoice.overdue -> creates OPEN risk for invoice", async () => {
      const now = new Date();
      const dueAt = new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000); // 4 days overdue

      const invoice = await createInvoice(
        { db },
        {
          tenantId: tenantAId,
          customerId: customerInvoiceId,
          number: `INV-${randomUUID().slice(0, 8)}`,
          amount: 10_000_000n, // ₹100,000 (amount_high +10)
          currency: "INR",
          status: "OVERDUE",
          dueAt,
        },
      );

      await app.eventBus.publish({
        id: randomUUID(),
        type: "invoice.overdue",
        occurred_at: new Date().toISOString(),
        source: "internal",
        tenant_id: tenantAId,
        customer_id: customerInvoiceId,
        entity_id: invoice.id,
        entity_type: "INVOICE",
        payload: { invoice_id: invoice.id },
        correlation_id: randomUUID(),
      });

      const risk = await app.repos.findLatestRiskForSubject(
        { db },
        {
          tenantId: tenantAId,
          subjectType: "INVOICE",
          subjectId: invoice.id,
        },
      );

      expect(risk).not.toBeNull();
      expect(risk!.riskType).toBe("INVOICE_OVERDUE");
      expect(risk!.status).toBe("OPEN");
      // days_overdue (+15) + amount_high (+10) + customer_active (+10) = 35 (LOW)
      expect(risk!.score).toBe(35);
      expect(risk!.band).toBe("LOW");
    }, 30000);
  });

  describe("5. REST Read APIs: GET /risks & GET /risks/:id", () => {
    it("GET /risks returns paginated list of risks for authenticated tenant", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/risks?limit=10",
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toBeDefined();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThan(0);
      // Verify all returned items belong strictly to Tenant A
      for (const item of body.items) {
        expect(item.tenantId).toBe(tenantAId);
      }
    }, 30000);

    it("GET /risks enforces strict tenant isolation (Tenant B cannot see Tenant A's risks)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/risks",
        headers: {
          authorization: `Bearer ${tenantBApiKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toBeDefined();
      // Tenant B has not had any risks created yet
      expect(body.items).toHaveLength(0);
    }, 30000);

    it("GET /risks/:id returns full risk with factors breakdown", async () => {
      // Find a Tenant A risk
      const listRes = await app.inject({
        method: "GET",
        url: "/risks?limit=1",
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
        },
      });
      const riskId = listRes.json().items[0].id;

      const res = await app.inject({
        method: "GET",
        url: `/risks/${riskId}`,
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe(riskId);
      expect(body.tenantId).toBe(tenantAId);
      expect(body.factors).toBeDefined();
      expect(body.factors.rules).toBeDefined();
      expect(body.factors.breakdown).toBeDefined();
    }, 30000);

    it("GET /risks/:id returns 404 when requested across tenant boundaries", async () => {
      const listRes = await app.inject({
        method: "GET",
        url: "/risks?limit=1",
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
        },
      });
      const riskId = listRes.json().items[0].id;

      // Tenant B attempts to fetch Tenant A's risk
      const res = await app.inject({
        method: "GET",
        url: `/risks/${riskId}`,
        headers: {
          authorization: `Bearer ${tenantBApiKey}`,
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
    }, 30000);
  });

  describe("6. Performance Smoke Test", () => {
    it("500 deterministic rule evaluations execute with average latency < 50ms", () => {
      const aggregates: SubjectAggregates = {
        tenantId: tenantAId,
        customerId: customerAId,
        customer: {
          id: customerAId,
          tenantId: tenantAId,
          externalRef: "perf_1",
          name: "Perf Customer",
          email: "perf@example.com",
          phone: null,
          status: "ACTIVE",
          lifetimeValue: 100000n,
          optedOut: false,
          optedOutAt: null,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        } as unknown as any,
        payment: {
          id: "pay_perf",
          tenantId: tenantAId,
          customerId: customerAId,
          amount: 8_000_000n,
          currency: "INR",
          status: "FAILED",
          provider: "STRIPE",
          providerPaymentId: "pi_perf",
          occurredAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as any,
        paymentsHistory: [
          { status: "SUCCEEDED", occurredAt: new Date() } as any,
          { status: "SUCCEEDED", occurredAt: new Date() } as any,
          { status: "SUCCEEDED", occurredAt: new Date() } as any,
        ],
        now: new Date(),
      };

      const start = performance.now();
      for (let i = 0; i < 500; i++) {
        scorePaymentFailure(aggregates);
      }
      const totalMs = performance.now() - start;
      const avgMs = totalMs / 500;

      expect(avgMs).toBeLessThan(50); // Target < 50ms avg (typically < 0.1ms for deterministic logic)
    });
  });
});
