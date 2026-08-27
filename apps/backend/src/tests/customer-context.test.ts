import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  createSubscription,
  createInvoice,
  createCheckout,
  createCase,
  recordOutcomeInTx,
  insertMessage,
  createCustomerResponse,
  withTransaction,
} from "@repo/db";
import { sha256 } from "../lib/crypto";
import { CustomerContextService } from "../modules/customers/customer-context.service";
import { CustomerContextSchema } from "../modules/customers/context/types";

describe("Step 13 Integration: Customer Context Service", { timeout: 45000 }, () => {
  let app: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;
  let tenantAApiKey: string;
  let tenantBApiKey: string;
  let richCustomerId: string;
  let emptyCustomerId: string;
  let richCaseId: string;

  const runId = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const eventBus = new NullBus();

    // 1. Create Tenant A & Tenant B
    const tenantA = await createTenant(
      { db },
      {
        name: `Context Tenant A ${runId}`,
        slug: `context-tenant-a-${runId}`,
      },
    );
    tenantAId = tenantA.id;

    const tenantB = await createTenant(
      { db },
      {
        name: `Context Tenant B ${runId}`,
        slug: `context-tenant-b-${runId}`,
      },
    );
    tenantBId = tenantB.id;

    // 2. Create API Keys for Tenant A and Tenant B
    const rawKeyA = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId: tenantAId,
        keyHash: sha256(rawKeyA),
        name: `Tenant A Key ${runId}`,
        scopes: ["*"],
      },
    );
    tenantAApiKey = rawKeyA;

    const rawKeyB = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId: tenantBId,
        keyHash: sha256(rawKeyB),
        name: `Tenant B Key ${runId}`,
        scopes: ["*"],
      },
    );
    tenantBApiKey = rawKeyB;

    // 3. Seed Rich History Customer for Tenant A
    const richCustomer = await createCustomer(
      { db },
      {
        tenantId: tenantAId,
        externalRef: `cus_rich_${runId}`,
        name: "Alice Johnson",
        email: "alice.johnson@example.com",
        phone: "+14155552671",
        status: "ACTIVE",
        lifetimeValue: 125000n,
        optedOut: false,
        metadata: {
          preferred_channel: "WHATSAPP",
          language: "en",
        },
      },
    );
    richCustomerId = richCustomer.id;

    // 4. Seed Empty History Customer for Tenant A
    const emptyCustomer = await createCustomer(
      { db },
      {
        tenantId: tenantAId,
        externalRef: `cus_empty_${runId}`,
        name: "Bob Clean",
        status: "ACTIVE",
        lifetimeValue: 0n,
        optedOut: false,
      },
    );
    emptyCustomerId = emptyCustomer.id;

    // 5. Seed Subscriptions & Payments for Rich Customer
    const sub = await createSubscription(
      { db },
      {
        tenantId: tenantAId,
        customerId: richCustomerId,
        planName: "Pro Annual",
        amount: 25000n,
        currency: "USD",
        status: "ACTIVE",
        provider: "STRIPE",
        providerSubscriptionId: `sub_${runId}`,
        currentPeriodStart: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() + 335 * 24 * 60 * 60 * 1000),
      },
    );

    // Succeeded payment (10d ago)
    const succPayment = await createPayment(
      { db },
      {
        tenantId: tenantAId,
        customerId: richCustomerId,
        subscriptionId: sub.id,
        amount: 25000n,
        currency: "USD",
        status: "SUCCEEDED",
        provider: "STRIPE",
        providerPaymentId: `pi_succ_${runId}`,
        occurredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        paidAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      },
    );

    // Failed payment (2d ago)
    await createPayment(
      { db },
      {
        tenantId: tenantAId,
        customerId: richCustomerId,
        subscriptionId: sub.id,
        amount: 25000n,
        currency: "USD",
        status: "FAILED",
        provider: "STRIPE",
        providerPaymentId: `pi_fail_${runId}`,
        failureCode: "insufficient_funds",
        failureMessage: "Not enough funds",
        occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    );

    // 6. Seed Invoices for Rich Customer
    await createInvoice(
      { db },
      {
        tenantId: tenantAId,
        customerId: richCustomerId,
        number: `INV-${runId}-01`,
        amount: 50000n,
        amountPaid: 10000n,
        currency: "USD",
        status: "OVERDUE",
        issuedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        dueAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5d overdue
      },
    );

    // 7. Seed Checkouts for Rich Customer
    await createCheckout(
      { db },
      {
        tenantId: tenantAId,
        customerId: richCustomerId,
        cartValue: 15000n,
        currency: "USD",
        status: "STARTED",
        sourceRef: `chk_${runId}`,
        startedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
        lastActivityAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      },
    );

    // 8. Seed Recovery Case & Authoritative Outcome for Rich Customer
    const recCase = await createCase(
      { db },
      {
        tenantId: tenantAId,
        customerId: richCustomerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "payments",
        sourceEntityId: succPayment.id,
        amountAtRisk: 25000n,
        currency: "USD",
        riskScore: 80,
        status: "RECOVERED",
        statusReason: "Recovered via smart retry",
      },
    );
    richCaseId = recCase.id;

    await withTransaction(async (tx) => {
      await recordOutcomeInTx(tx, {
        tenantId: tenantAId,
        caseId: recCase.id,
        paymentId: succPayment.id,
        baselineAmount: 25000n,
        recoveredAmount: 25000n,
        recoveryCost: 500n,
        attributionMethod: "DIRECT_PAYMENT",
        attributionWindowHours: 72,
        recoveredAt: new Date(),
      });
    });

    // 9. Seed Communications (Messages & Customer Responses)
    await insertMessage(
      { db },
      {
        tenantId: tenantAId,
        caseId: recCase.id,
        customerId: richCustomerId,
        channel: "WHATSAPP",
        direction: "OUTBOUND",
        templateId: "payment_retry_notice",
        toAddress: "+14155552671",
        provider: "MOCK",
        idempotencyKey: `msg_${runId}_1`,
        status: "DELIVERED",
        sentAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    );

    await createCustomerResponse(
      { db },
      {
        tenantId: tenantAId,
        customerId: richCustomerId,
        caseId: recCase.id,
        channel: "WHATSAPP",
        type: "PROMISE_TO_PAY",
        contentRedacted: "Will pay tomorrow",
        receivedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      },
    );

    // Build Fastify App instance
    app = await buildApp({
      customDb: db,
      eventBus,
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe("1. GET /customers/:id/context Contract & Snapshot", () => {
    it("returns full allowlisted, size-bounded context matching Spec 01 §9 shape", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/customers/${richCustomerId}/context?purpose=api_read`,
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);

      // Verify custom headers
      expect(response.headers["x-context-built-at"]).toBeDefined();
      expect(response.headers["x-context-bytes"]).toBeDefined();

      const body = JSON.parse(response.body);

      // Validate against strict Zod runtime schema
      const validated = CustomerContextSchema.safeParse(body);
      expect(validated.success).toBe(true);

      // Assert section details
      expect(body.customer.id).toBe(richCustomerId);
      expect(body.customer.name).toBe("Alice Johnson");
      expect(body.customer.email_masked).toBe("a***@e***.com");
      expect(body.customer.phone_masked).toBe("+1***2671");
      expect(body.customer.lifetime_value_minor).toBe(125000);

      // Payment summary
      expect(body.payment_summary.succeeded_count_180d).toBe(1);
      expect(body.payment_summary.failed_count_180d).toBe(1);
      expect(body.payment_summary.last_failure_code).toBe("insufficient_funds");
      expect(body.payment_summary.total_paid_minor).toBe(25000);

      // Subscription summary
      expect(body.subscription_summary.status).toBe("ACTIVE");
      expect(body.subscription_summary.plan_name).toBe("Pro Annual");
      expect(body.subscription_summary.amount_minor).toBe(25000);

      // Invoice summary
      expect(body.invoice_summary.open_count).toBe(1);
      expect(body.invoice_summary.overdue_count).toBe(1);
      expect(body.invoice_summary.worst_days_overdue).toBeGreaterThanOrEqual(4);
      expect(body.invoice_summary.total_overdue_minor).toBe(40000);

      // Checkout summary
      expect(body.checkout_summary.active_carts).toBe(1);
      expect(body.checkout_summary.last_cart_value_minor).toBe(15000);

      // Recovery history
      expect(body.recovery_history.prior_cases).toBe(1);
      expect(body.recovery_history.recovered_cases).toBe(1);
      expect(body.recovery_history.last_outcome.amount_recovered_minor).toBe(25000);
      expect(body.recovery_history.retry_success_rate).toBe(1);

      // Communication history
      expect(body.communication_history.whatsapp_last_7d).toBe(1);
      expect(body.communication_history.reply_rate).toBe(1);

      // Preferences
      expect(body.preferences.preferred_channel).toBe("WHATSAPP");
      expect(body.preferences.language).toBe("en");
    });

    it("returns zero-filled valid schema shape for empty-history customer", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/customers/${emptyCustomerId}/context`,
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      const validated = CustomerContextSchema.safeParse(body);
      expect(validated.success).toBe(true);

      expect(body.customer.id).toBe(emptyCustomerId);
      expect(body.customer.email_masked).toBeNull();
      expect(body.payment_summary.succeeded_count_180d).toBe(0);
      expect(body.payment_summary.failed_count_180d).toBe(0);
      expect(body.subscription_summary.status).toBeNull();
      expect(body.invoice_summary.open_count).toBe(0);
      expect(body.checkout_summary.active_carts).toBe(0);
      expect(body.recovery_history.prior_cases).toBe(0);
      expect(body.communication_history.whatsapp_last_7d).toBe(0);
    });
  });

  describe("2. Security & Tenant Isolation", () => {
    it("returns 404 NOT_FOUND when requesting another tenant's customer (no existence leak)", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/customers/${richCustomerId}/context`,
        headers: {
          authorization: `Bearer ${tenantBApiKey}`, // Tenant B requesting Tenant A's customer
        },
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe("NOT_FOUND");
    });

    it("returns 401 UNAUTHENTICATED without credentials", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/customers/${richCustomerId}/context`,
      });

      expect(response.statusCode).toBe(401);
    });

    it("returns 422 for invalid UUID parameter", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/customers/not-a-uuid/context`,
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
        },
      });

      expect(response.statusCode).toBe(422);
    });
  });

  describe("3. Redis Caching & Cache Invalidation", () => {
    it("serves repeated requests within 30s from Redis cache and supports invalidation", async () => {
      // 1. Initial request (populates cache)
      const res1 = await app.inject({
        method: "GET",
        url: `/customers/${richCustomerId}/context?purpose=api_read`,
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
        },
      });
      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.body);

      // 2. Second request hits Redis cache (same built_at)
      const res2 = await app.inject({
        method: "GET",
        url: `/customers/${richCustomerId}/context?purpose=api_read`,
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
        },
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.body);
      expect(body2.built_at).toBe(body1.built_at);

      // 3. Invalidate cache
      await CustomerContextService.invalidateCache(
        app.redisClient,
        tenantAId,
        richCustomerId,
      );

      // 4. Force fresh query
      const res3 = await app.inject({
        method: "GET",
        url: `/customers/${richCustomerId}/context?purpose=api_read&fresh=true`,
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
        },
      });
      expect(res3.statusCode).toBe(200);
    });
  });

  describe("4. Internal Service API: buildForCase", () => {
    it("resolves recovery case -> customer and builds context with purpose=ai_decision", async () => {
      const context = await CustomerContextService.buildForCase({
        tenantId: tenantAId,
        caseId: richCaseId,
        purpose: "ai_decision",
        db,
        repos: app.repos,
        redis: app.redisClient,
      });

      expect(context).toBeDefined();
      expect(context.customer.id).toBe(richCustomerId);
      expect(context.recovery_history.prior_cases).toBeGreaterThanOrEqual(1);
    });

    it("throws CASE_NOT_FOUND when case does not exist or across tenants", async () => {
      await expect(
        CustomerContextService.buildForCase({
          tenantId: tenantBId, // Tenant B requesting Tenant A's case
          caseId: richCaseId,
          db,
          repos: app.repos,
          redis: app.redisClient,
        }),
      ).rejects.toThrow("Recovery case");
    });
  });

  describe("5. Latency Performance Smoke Test", () => {
    it("measures context build latency across sequential invocations", async () => {
      // Warmup call
      await CustomerContextService.build({
        tenantId: tenantAId,
        customerId: richCustomerId,
        purpose: "ai_decision",
        forceFresh: true,
        db,
        repos: app.repos,
      });

      const latencies: number[] = [];
      const count = 5;

      for (let i = 0; i < count; i++) {
        const start = performance.now();
        const ctx = await CustomerContextService.build({
          tenantId: tenantAId,
          customerId: richCustomerId,
          purpose: "ai_decision",
          forceFresh: true,
          db,
          repos: app.repos,
        });
        const duration = performance.now() - start;
        latencies.push(duration);
        expect(ctx.customer.id).toBe(richCustomerId);
      }

      expect(latencies.length).toBe(count);
      const avg = latencies.reduce((a, b) => a + b, 0) / count;
      expect(avg).toBeGreaterThan(0);
    }, 30000);
  });
});
