import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { InProcessEventBus } from "@repo/integrations";
import {
  db,
  createTenant,
  createUser,
  createSession,
  createCustomer,
  createCase,
  createPayment,
  recordCostEntry,
  insertAction,
  recordCaseEvent,
  createDecision,
  recordPolicyEvaluation,
  insertMessage,
  recordOutcomeInTx,
  type Tenant,
  type Customer,
  type RecoveryCase,
} from "@repo/db";
import { sha256 } from "../lib/crypto";
import { OutcomeRecordService } from "../modules/outcomes/record.service";

describe("Step 27 Integration: Analytics Service & APIs", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let eventBus: InProcessEventBus;

  let tenantA: Tenant;
  let tenantB: Tenant;

  let viewerCookie: string;
  let financeCookie: string;
  let adminCookie: string;
  let tenantBCookie: string;

  let recordService: OutcomeRecordService;

  let cusA1: Customer;
  let cusA2: Customer;
  let cusA3: Customer;

  let case1: RecoveryCase;
  let case2: RecoveryCase;
  let case3: RecoveryCase;
  let case4: RecoveryCase;

  const FROM_DATE = "2026-08-01T00:00:00.000Z";
  const TO_DATE = "2026-08-31T23:59:59.999Z";

  beforeAll(async () => {
    eventBus = new InProcessEventBus();
    app = await buildApp({
      customDb: db,
      eventBus,
      disableRateLimit: true,
    });
    await app.ready();

    recordService = new OutcomeRecordService(db, app.repos, app.redisClient);

    // 1. Seed Tenants
    tenantA = await createTenant(
      { db },
      { name: `Analytics Tenant A ${randomUUID()}`, slug: `tenant-ana-a-${randomUUID().slice(0, 8)}` },
    );
    tenantB = await createTenant(
      { db },
      { name: `Analytics Tenant B ${randomUUID()}`, slug: `tenant-ana-b-${randomUUID().slice(0, 8)}` },
    );

    // 2. Seed Users & Sessions for Tenant A
    const viewerUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `viewer-${randomUUID().slice(0, 8)}@example.com`,
        name: "Viewer User",
        role: "VIEWER",
        status: "ACTIVE",
      },
    );
    const viewerRawToken = `tok_viewer_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: viewerUser.id,
        tokenHash: sha256(viewerRawToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    );
    viewerCookie = `rr_session=${viewerRawToken}`;

    const financeUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `finance-${randomUUID().slice(0, 8)}@example.com`,
        name: "Finance User",
        role: "FINANCE",
        status: "ACTIVE",
      },
    );
    const financeRawToken = `tok_fin_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: financeUser.id,
        tokenHash: sha256(financeRawToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    );
    financeCookie = `rr_session=${financeRawToken}`;

    const adminUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `admin-${randomUUID().slice(0, 8)}@example.com`,
        name: "Admin User",
        role: "ADMIN",
        status: "ACTIVE",
      },
    );
    const adminRawToken = `tok_adm_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: adminUser.id,
        tokenHash: sha256(adminRawToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    );
    adminCookie = `rr_session=${adminRawToken}`;

    // Seed Tenant B Admin
    const tenantBUser = await createUser(
      { db },
      {
        tenantId: tenantB.id,
        email: `tenantb-${randomUUID().slice(0, 8)}@example.com`,
        name: "Tenant B Admin",
        role: "ADMIN",
        status: "ACTIVE",
      },
    );
    const tenantBRawToken = `tok_tb_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: tenantBUser.id,
        tokenHash: sha256(tenantBRawToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    );
    tenantBCookie = `rr_session=${tenantBRawToken}`;

    // 3. Seed Customers for Tenant A
    cusA1 = await createCustomer(
      { db },
      {
        tenantId: tenantA.id,
        email: "cusa1@example.com",
        phone: "+919876543210",
        name: "Customer A1",
        status: "ACTIVE",
      },
    );
    cusA2 = await createCustomer(
      { db },
      {
        tenantId: tenantA.id,
        email: "cusa2@example.com",
        phone: "+919876543211",
        name: "Customer A2",
        status: "ACTIVE",
      },
    );
    cusA3 = await createCustomer(
      { db },
      {
        tenantId: tenantA.id,
        email: "cusa3@example.com",
        phone: "+919876543212",
        name: "Customer A3",
        status: "ACTIVE",
      },
    );

    // 4. Seed Golden Month Dataset for Tenant A
    // Case 1: PAYMENT_FAILURE (amount: 10000n paise / ₹100), opened: 2026-08-01, recovered: 2026-08-02
    case1 = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: cusA1.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: randomUUID(),
        amountAtRisk: 10000n,
        currency: "INR",
        riskScore: 85,
        status: "RECOVERED",
        openedAt: new Date("2026-08-01T10:00:00.000Z"),
      },
    );

    const dec1 = await createDecision(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case1.id,
        model: "gpt-4o-mini",
        promptVersion: "v1.0",
        inputSnapshot: { caseId: case1.id },
        recommendedActions: [{ type: "SEND_WHATSAPP" }],
        status: "COMPLETED",
        latencyMs: 450,
        inputTokens: 200,
        outputTokens: 50,
        costMinorUnits: 10n,
        // Golden-month fixture: decision belongs to the August window (s-30 fix —
        // createdAt otherwise defaults to now and drifts out of FROM/TO over time).
        createdAt: new Date("2026-08-01T10:01:00.000Z"),
      },
    );

    await recordPolicyEvaluation(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case1.id,
        decisionId: dec1.id,
        ruleVersions: [],
        result: "ALLOWED",
        rejections: [],
        effectiveActions: [{ type: "SEND_WHATSAPP" }],
        latencyMs: 15,
        evaluatedAt: new Date("2026-08-01T10:01:05.000Z"),
      },
    );

    const act1 = await insertAction(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case1.id,
        decisionId: dec1.id,
        type: "SEND_WHATSAPP",
        parameters: {},
        status: "EXECUTED",
        idempotencyKey: `${tenantA.id}:${case1.id}:SEND_WHATSAPP:1`,
        completedAt: new Date("2026-08-01T10:02:00.000Z"),
        createdAt: new Date("2026-08-01T10:02:00.000Z"),
      },
    );

    await recordCostEntry(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case1.id,
        category: "MESSAGING",
        amount: 50n,
        currency: "INR",
        incurredAt: new Date("2026-08-01T10:02:00.000Z"),
      },
    );

    await insertMessage(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case1.id,
        customerId: cusA1.id,
        channel: "WHATSAPP",
        templateId: "tpl_recovery_reminder",
        toAddress: cusA1.phone!,
        provider: "WHATSAPP_CLOUD",
        idempotencyKey: `msg:${tenantA.id}:${case1.id}:1`,
        status: "DELIVERED",
        sentAt: new Date("2026-08-01T10:02:00.000Z"),
      },
    );

    const pay1 = await createPayment(
      { db },
      {
        tenantId: tenantA.id,
        customerId: cusA1.id,
        amount: 10000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "STRIPE",
        providerPaymentId: `pi_test_${randomUUID().slice(0, 8)}`,
        occurredAt: new Date("2026-08-02T12:00:00.000Z"),
      },
    );

    await recordOutcomeInTx(db as any, {
      tenantId: tenantA.id,
      caseId: case1.id,
      paymentId: pay1.id,
      baselineAmount: 10000n,
      recoveredAmount: 10000n,
      recoveryCost: 50n,
      attributionMethod: "WORKFLOW_LINKED",
      attributionWindowHours: 72,
      recoveredAt: new Date("2026-08-02T12:00:00.000Z"),
    });

    // Case 2: INVOICE_OVERDUE (amount: 50000n paise / ₹500), opened: 2026-08-05, escalated -> recovered: 2026-08-10
    case2 = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: cusA2.id,
        riskType: "INVOICE_OVERDUE",
        sourceEntityType: "INVOICE",
        sourceEntityId: randomUUID(),
        amountAtRisk: 50000n,
        currency: "INR",
        riskScore: 75,
        status: "RECOVERED",
        openedAt: new Date("2026-08-05T09:00:00.000Z"),
      },
    );

    const dec2 = await createDecision(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case2.id,
        model: "gpt-4o-mini",
        promptVersion: "v1.0",
        inputSnapshot: { caseId: case2.id },
        recommendedActions: [{ type: "OFFER_INCENTIVE" }],
        status: "COMPLETED",
        latencyMs: 550,
        inputTokens: 250,
        outputTokens: 60,
        costMinorUnits: 15n,
        createdAt: new Date("2026-08-05T09:01:00.000Z"),
      },
    );

    await recordPolicyEvaluation(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case2.id,
        decisionId: dec2.id,
        ruleVersions: [],
        result: "REQUIRE_APPROVAL",
        rejections: [],
        effectiveActions: [{ type: "OFFER_INCENTIVE" }],
        latencyMs: 20,
        evaluatedAt: new Date("2026-08-05T09:01:05.000Z"),
      },
    );

    await recordCaseEvent(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case2.id,
        eventType: "CASE_ESCALATED",
        actorType: "SYSTEM",
        occurredAt: new Date("2026-08-05T09:02:00.000Z"),
      },
    );

    await insertAction(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case2.id,
        decisionId: dec2.id,
        type: "OFFER_INCENTIVE",
        parameters: { discount_pct: 10 },
        status: "EXECUTED",
        idempotencyKey: `${tenantA.id}:${case2.id}:OFFER_INCENTIVE:1`,
        completedAt: new Date("2026-08-05T10:00:00.000Z"),
        createdAt: new Date("2026-08-05T10:00:00.000Z"),
      },
    );

    await recordCostEntry(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case2.id,
        category: "DISCOUNT",
        amount: 500n,
        currency: "INR",
        incurredAt: new Date("2026-08-05T10:00:00.000Z"),
      },
    );

    await insertMessage(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case2.id,
        customerId: cusA2.id,
        channel: "EMAIL",
        templateId: "tpl_invoice_reminder",
        toAddress: cusA2.email!,
        provider: "SMTP_EMAIL",
        idempotencyKey: `msg:${tenantA.id}:${case2.id}:1`,
        status: "SENT",
        sentAt: new Date("2026-08-05T10:00:00.000Z"),
      },
    );

    const pay2 = await createPayment(
      { db },
      {
        tenantId: tenantA.id,
        customerId: cusA2.id,
        amount: 50000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "RAZORPAY",
        providerPaymentId: `pay_test_${randomUUID().slice(0, 8)}`,
        occurredAt: new Date("2026-08-10T15:00:00.000Z"),
      },
    );

    await recordOutcomeInTx(db as any, {
      tenantId: tenantA.id,
      caseId: case2.id,
      paymentId: pay2.id,
      baselineAmount: 50000n,
      recoveredAmount: 50000n,
      recoveryCost: 500n,
      attributionMethod: "ATTRIBUTION_WINDOW",
      attributionWindowHours: 120,
      recoveredAt: new Date("2026-08-10T15:00:00.000Z"),
    });

    // Case 3: CHECKOUT_ABANDONMENT (amount: 25000n paise / ₹250), opened: 2026-08-15, stopped
    case3 = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: cusA3.id,
        riskType: "CHECKOUT_ABANDONMENT",
        sourceEntityType: "CHECKOUT",
        sourceEntityId: randomUUID(),
        amountAtRisk: 25000n,
        currency: "INR",
        riskScore: 50,
        status: "STOPPED",
        openedAt: new Date("2026-08-15T14:00:00.000Z"),
      },
    );

    const dec3 = await createDecision(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case3.id,
        model: "gpt-4o-mini",
        promptVersion: "v1.0",
        inputSnapshot: { caseId: case3.id },
        recommendedActions: [{ type: "SEND_EMAIL" }],
        status: "COMPLETED",
        latencyMs: 400,
        inputTokens: 180,
        outputTokens: 40,
        costMinorUnits: 8n,
        createdAt: new Date("2026-08-15T14:01:00.000Z"),
      },
    );

    await recordPolicyEvaluation(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case3.id,
        decisionId: dec3.id,
        ruleVersions: [],
        result: "ALLOWED",
        rejections: [],
        effectiveActions: [{ type: "SEND_EMAIL" }],
        latencyMs: 10,
        evaluatedAt: new Date("2026-08-15T14:01:05.000Z"),
      },
    );

    await insertAction(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case3.id,
        decisionId: dec3.id,
        type: "SEND_EMAIL",
        parameters: {},
        status: "EXECUTED",
        idempotencyKey: `${tenantA.id}:${case3.id}:SEND_EMAIL:1`,
        completedAt: new Date("2026-08-15T14:02:00.000Z"),
        createdAt: new Date("2026-08-15T14:02:00.000Z"),
      },
    );

    await insertMessage(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case3.id,
        customerId: cusA3.id,
        channel: "EMAIL",
        templateId: "tpl_cart_reminder",
        toAddress: cusA3.email!,
        provider: "SMTP_EMAIL",
        idempotencyKey: `msg:${tenantA.id}:${case3.id}:1`,
        status: "DELIVERED",
        sentAt: new Date("2026-08-15T14:02:00.000Z"),
      },
    );

    // Case 4: PAYMENT_FAILURE (amount: 30000n paise / ₹300), opened: 2026-08-20, status: IN_PROGRESS (Active Case)
    case4 = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: cusA3.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: randomUUID(),
        amountAtRisk: 30000n,
        currency: "INR",
        riskScore: 30,
        status: "IN_PROGRESS",
        openedAt: new Date("2026-08-20T11:00:00.000Z"),
      },
    );

    const dec4 = await createDecision(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case4.id,
        model: "gpt-4o-mini",
        promptVersion: "v1.0",
        inputSnapshot: { caseId: case4.id },
        recommendedActions: [{ type: "RETRY_PAYMENT" }],
        status: "COMPLETED",
        latencyMs: 500,
        inputTokens: 220,
        outputTokens: 50,
        costMinorUnits: 12n,
        createdAt: new Date("2026-08-20T11:01:00.000Z"),
      },
    );

    await recordPolicyEvaluation(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case4.id,
        decisionId: dec4.id,
        ruleVersions: [],
        result: "REJECTED",
        rejections: [{ reason: "LIMIT_REACHED" }],
        effectiveActions: [],
        latencyMs: 12,
        evaluatedAt: new Date("2026-08-20T11:01:05.000Z"),
      },
    );

    await insertAction(
      { db },
      {
        tenantId: tenantA.id,
        caseId: case4.id,
        decisionId: dec4.id,
        type: "RETRY_PAYMENT",
        parameters: {},
        status: "EXECUTED",
        idempotencyKey: `${tenantA.id}:${case4.id}:RETRY_PAYMENT:1`,
        completedAt: new Date("2026-08-20T11:02:00.000Z"),
        createdAt: new Date("2026-08-20T11:02:00.000Z"),
      },
    );

    // 5. Seed Tenant B with 1 case & outcome for isolation verification
    const cusB = await createCustomer(
      { db },
      {
        tenantId: tenantB.id,
        email: "cusb@example.com",
        name: "Tenant B Customer",
        status: "ACTIVE",
      },
    );
    const caseB = await createCase(
      { db },
      {
        tenantId: tenantB.id,
        customerId: cusB.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: randomUUID(),
        amountAtRisk: 99000n,
        currency: "INR",
        riskScore: 90,
        status: "RECOVERED",
        openedAt: new Date("2026-08-01T10:00:00.000Z"),
      },
    );
    const payB = await createPayment(
      { db },
      {
        tenantId: tenantB.id,
        customerId: cusB.id,
        amount: 99000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "STRIPE",
        providerPaymentId: `pi_b_${randomUUID().slice(0, 8)}`,
        occurredAt: new Date("2026-08-02T10:00:00.000Z"),
      },
    );
    await recordOutcomeInTx(db as any, {
      tenantId: tenantB.id,
      caseId: caseB.id,
      paymentId: payB.id,
      baselineAmount: 99000n,
      recoveredAmount: 99000n,
      recoveryCost: 1000n,
      attributionMethod: "WORKFLOW_LINKED",
      attributionWindowHours: 72,
      recoveredAt: new Date("2026-08-02T10:00:00.000Z"),
    });
  });

  describe("1. GET /analytics/summary", () => {
    it("returns authoritative financial and operational cards for FINANCE role", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/analytics/summary?from=${FROM_DATE}&to=${TO_DATE}`,
        headers: { cookie: financeCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-cost-data-redacted"]).toBeUndefined();

      const body = JSON.parse(res.body);

      // Financial calculations:
      // at_risk: case 3 (25000) + case 4 (30000) = 55000 (cases 1 & 2 are RECOVERED)
      expect(body.financial.revenue_at_risk_minor).toBe("55000");
      // recovered: case 1 (10000) + case 2 (50000) = 60000
      expect(body.financial.revenue_recovered_minor).toBe("60000");
      // recovery_cost: case 1 (50) + case 2 (500) = 550
      expect(body.financial.recovery_cost_minor).toBe("550");
      // net_recovered: case 1 (9950) + case 2 (49500) = 59450
      expect(body.financial.net_recovered_minor).toBe("59450");
      expect(body.financial.currency).toBe("INR");
      expect(body.financial.recovery_rate_bps).toBe(10909); // (60000 * 10000) / 55000 = 10909
      expect(body.financial.recovery_roi_bps).toBe(1080909); // (59450 * 10000) / 550 = 1080909

      // Operational calculations:
      // active_cases: case 4 (IN_PROGRESS) = 1
      expect(body.operational.active_cases).toBe(1);
      // escalations: 1 (from case 2)
      expect(body.operational.escalations).toBe(1);
      expect(body.operational.avg_time_to_recovery_seconds).toBeGreaterThan(0);
    });

    it("redacts cost fields for VIEWER role and sets x-cost-data-redacted header", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/analytics/summary?from=${FROM_DATE}&to=${TO_DATE}`,
        headers: { cookie: viewerCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-cost-data-redacted"]).toBe("true");

      const body = JSON.parse(res.body);

      // Financial visible fields
      expect(body.financial.revenue_at_risk_minor).toBe("55000");
      expect(body.financial.revenue_recovered_minor).toBe("60000");
      expect(body.financial.recovery_rate_bps).toBe(10909);
      expect(body.financial.currency).toBe("INR");

      // Cost fields must be omitted
      expect(body.financial.recovery_cost_minor).toBeUndefined();
      expect(body.financial.net_recovered_minor).toBeUndefined();
      expect(body.financial.recovery_roi_bps).toBeUndefined();

      // Operational fields untouched
      expect(body.operational.active_cases).toBe(1);
      expect(body.operational.escalations).toBe(1);
    });
  });

  describe("2. GET /analytics/recovery", () => {
    it("returns daily time-series with UTC date buckets and role-based gating", async () => {
      // 1. Finance caller sees cost and net
      const resFin = await app.inject({
        method: "GET",
        url: `/analytics/recovery?from=${FROM_DATE}&to=${TO_DATE}&bucket=day`,
        headers: { cookie: financeCookie },
      });

      expect(resFin.statusCode).toBe(200);
      const bodyFin = JSON.parse(resFin.body);

      expect(bodyFin.bucket).toBe("day");
      expect(Array.isArray(bodyFin.timeseries)).toBe(true);
      expect(bodyFin.timeseries.length).toBeGreaterThan(0);

      // Every item has net_minor and recovery_cost_minor for FINANCE
      for (const item of bodyFin.timeseries) {
        expect(typeof item.date).toBe("string");
        expect(typeof item.at_risk_minor).toBe("string");
        expect(typeof item.recovered_minor).toBe("string");
        expect(typeof item.recovery_cost_minor).toBe("string");
        expect(typeof item.net_minor).toBe("string");
      }

      // 2. Viewer caller has net_minor and recovery_cost_minor omitted
      const resViewer = await app.inject({
        method: "GET",
        url: `/analytics/recovery?from=${FROM_DATE}&to=${TO_DATE}&bucket=day`,
        headers: { cookie: viewerCookie },
      });

      expect(resViewer.statusCode).toBe(200);
      expect(resViewer.headers["x-cost-data-redacted"]).toBe("true");
      const bodyViewer = JSON.parse(resViewer.body);

      for (const item of bodyViewer.timeseries) {
        expect(typeof item.date).toBe("string");
        expect(typeof item.at_risk_minor).toBe("string");
        expect(typeof item.recovered_minor).toBe("string");
        expect(item.recovery_cost_minor).toBeUndefined();
        expect(item.net_minor).toBeUndefined();
      }
    });

    it("supports week bucketing", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/analytics/recovery?from=${FROM_DATE}&to=${TO_DATE}&bucket=week`,
        headers: { cookie: adminCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.bucket).toBe("week");
      expect(Array.isArray(body.timeseries)).toBe(true);
    });
  });

  describe("3. GET /analytics/interventions", () => {
    it("returns performance aggregates per action type", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/analytics/interventions?from=${FROM_DATE}&to=${TO_DATE}`,
        headers: { cookie: viewerCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThanOrEqual(4);

      const whatsappItem = body.items.find((i: any) => i.type === "SEND_WHATSAPP");
      expect(whatsappItem).toBeDefined();
      expect(whatsappItem.cases).toBe(1);
      expect(whatsappItem.successes).toBe(1);
      expect(whatsappItem.recovered_minor).toBe("10000");
      expect(whatsappItem.success_rate_bps).toBe(10000);

      const incentiveItem = body.items.find((i: any) => i.type === "OFFER_INCENTIVE");
      expect(incentiveItem).toBeDefined();
      expect(incentiveItem.cases).toBe(1);
      expect(incentiveItem.successes).toBe(1);
      expect(incentiveItem.recovered_minor).toBe("50000");
      expect(incentiveItem.success_rate_bps).toBe(10000);

      const emailItem = body.items.find((i: any) => i.type === "SEND_EMAIL");
      expect(emailItem).toBeDefined();
      expect(emailItem.cases).toBe(1);
      expect(emailItem.successes).toBe(0); // Case 3 was not recovered
      expect(emailItem.recovered_minor).toBe("0");
      expect(emailItem.success_rate_bps).toBe(0);
    });
  });

  describe("4. GET /analytics/funnel", () => {
    it("returns 5-stage funnel progression counts and conversion rate", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/analytics/funnel?from=${FROM_DATE}&to=${TO_DATE}`,
        headers: { cookie: viewerCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(Array.isArray(body.stages)).toBe(true);
      expect(body.stages.length).toBe(5);

      const atRiskStage = body.stages.find((s: any) => s.stage === "AT_RISK");
      const qualifiedStage = body.stages.find((s: any) => s.stage === "QUALIFIED");
      const contactedStage = body.stages.find((s: any) => s.stage === "CONTACTED");
      const attemptedStage = body.stages.find((s: any) => s.stage === "ATTEMPTED");
      const recoveredStage = body.stages.find((s: any) => s.stage === "RECOVERED");

      expect(atRiskStage.count).toBe(4);
      expect(atRiskStage.amount_minor).toBe("115000"); // 10000 + 50000 + 25000 + 30000

      expect(qualifiedStage.count).toBe(4);
      expect(contactedStage.count).toBe(3); // cases 1, 2, 3 had messages
      expect(attemptedStage.count).toBe(4); // cases 1, 2, 3, 4 had actions
      expect(recoveredStage.count).toBe(2); // cases 1, 2 had outcomes
      expect(recoveredStage.amount_minor).toBe("60000");

      expect(body.conversion_rate_bps).toBe(5000); // 2 / 4 = 50% = 5000 bps
    });
  });

  describe("5. GET /analytics/risk-mix", () => {
    it("returns risk mix breakdown across risk types and risk bands", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/analytics/risk-mix?from=${FROM_DATE}&to=${TO_DATE}`,
        headers: { cookie: viewerCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThanOrEqual(3);

      for (const item of body.items) {
        expect(typeof item.risk_type).toBe("string");
        expect(typeof item.risk_band).toBe("string");
        expect(typeof item.count).toBe("number");
        expect(typeof item.amount_at_risk_minor).toBe("string");
      }
    });
  });

  describe("6. GET /analytics/ai", () => {
    it("returns AI governance autonomy metrics and cost economics for FINANCE role", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/analytics/ai?from=${FROM_DATE}&to=${TO_DATE}`,
        headers: { cookie: financeCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(body.decisions).toBe(4);
      expect(body.decision_acceptance_rate_bps).toBe(10000); // 4 executed / 4 recommended = 100%
      expect(body.policy_rejections).toBe(1); // 1 evaluation REJECTED
      expect(body.policy_rejection_rate_bps).toBe(2500); // 1/4 = 25% = 2500 bps
      expect(body.approvals_required).toBe(1); // 1 evaluation APPROVAL_REQUIRED
      expect(body.avg_decision_ms).toBeGreaterThan(0);

      // Cost fields visible for FINANCE
      expect(body.total_ai_cost_minor).toBe("45"); // 10 + 15 + 8 + 12 = 45 paise
      expect(body.cost_per_case_minor).toBe("11"); // 45 / 4 = 11 paise
      expect(typeof body.cost_per_recovered_bps).toBe("number");
    });

    it("redacts AI cost economics for VIEWER role", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/analytics/ai?from=${FROM_DATE}&to=${TO_DATE}`,
        headers: { cookie: viewerCookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-cost-data-redacted"]).toBe("true");

      const body = JSON.parse(res.body);
      expect(body.decisions).toBe(4);
      expect(body.total_ai_cost_minor).toBeUndefined();
      expect(body.cost_per_case_minor).toBeUndefined();
      expect(body.cost_per_recovered_bps).toBeUndefined();
    });
  });

  describe("7. Range Validation & Boundaries", () => {
    it("rejects date range exceeding 370 days with 400 BAD_REQUEST", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/analytics/summary?from=2025-01-01T00:00:00.000Z&to=2026-08-31T23:59:59.999Z",
        headers: { cookie: viewerCookie },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("exceeds maximum allowed window");
    });

    it("rejects 'from' after 'to' with 400 BAD_REQUEST", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/analytics/summary?from=2026-08-31T00:00:00.000Z&to=2026-08-01T00:00:00.000Z",
        headers: { cookie: viewerCookie },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("cannot be after");
    });

    it("caps single-sided ?from=X alone against now() with 400 when unbounded (>370d)", async () => {
      const oldFrom = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
      const res = await app.inject({
        method: "GET",
        url: `/analytics/summary?from=${oldFrom}`,
        headers: { cookie: viewerCookie },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("exceeds maximum allowed window");
    });

    it("caps single-sided ?to=Y alone against now() with 400 when unbounded (>370d)", async () => {
      const oldTo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
      const res = await app.inject({
        method: "GET",
        url: `/analytics/summary?to=${oldTo}`,
        headers: { cookie: viewerCookie },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("BAD_REQUEST");
      expect(body.error.message).toContain("exceeds maximum allowed window");
    });

    it("allows recent single-sided bounds within 370d", async () => {
      const recentFrom = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const res = await app.inject({
        method: "GET",
        url: `/analytics/summary?from=${recentFrom}`,
        headers: { cookie: viewerCookie },
      });
      expect(res.statusCode).toBe(200);
    });

    it("returns zero-shaped valid response for empty date range without errors", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/analytics/summary?from=2024-01-01T00:00:00.000Z&to=2024-01-02T00:00:00.000Z",
        headers: { cookie: financeCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.financial.revenue_at_risk_minor).toBe("0");
      expect(body.financial.revenue_recovered_minor).toBe("0");
      expect(body.financial.recovery_cost_minor).toBe("0");
      expect(body.financial.net_recovered_minor).toBe("0");
      expect(body.financial.recovery_rate_bps).toBe(0);
      expect(body.financial.recovery_roi_bps).toBeNull();
    });
  });

  describe("8. Strict Tenant Isolation", () => {
    it("guarantees Tenant B receives only Tenant B data with zero cross-tenant leakage", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/analytics/summary?from=${FROM_DATE}&to=${TO_DATE}`,
        headers: { cookie: tenantBCookie },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      // Tenant B has 1 case recovered with 99000 paise
      expect(body.financial.revenue_recovered_minor).toBe("99000");
      expect(body.financial.recovery_cost_minor).toBe("1000");
      expect(body.financial.net_recovered_minor).toBe("98000");
      expect(body.financial.revenue_at_risk_minor).toBe("0"); // It was already RECOVERED
      expect(body.operational.active_cases).toBe(0);
    });
  });

  describe("9. Cache Busting on Outcome Recording", () => {
    it("serves cached analytics response and invalidates cache when new outcome is recorded", async () => {
      // 1. Initial query populates cache
      const res1 = await app.inject({
        method: "GET",
        url: `/analytics/summary?from=${FROM_DATE}&to=${TO_DATE}`,
        headers: { cookie: financeCookie },
      });
      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.body);
      const initialRecovered = body1.financial.revenue_recovered_minor;

      // 2. Add a new payment and record outcome for Case 4
      const payNew = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: cusA3.id,
          amount: 30000n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: `pi_bust_${randomUUID().slice(0, 8)}`,
          occurredAt: new Date("2026-08-25T10:00:00.000Z"),
        },
      );

      // Record outcome through OutcomeRecordService which triggers invalidateAnalyticsCache
      await recordService.recordOutcome({
        tenantId: tenantA.id,
        caseId: case4.id,
        paymentId: payNew.id,
        recoveredAmount: 30000n,
        recoveredAt: new Date("2026-08-25T10:00:00.000Z"),
      });

      // 3. Next query reflects the updated outcome value immediately (cache was invalidated)
      const res2 = await app.inject({
        method: "GET",
        url: `/analytics/summary?from=${FROM_DATE}&to=${TO_DATE}`,
        headers: { cookie: financeCookie },
      });
      expect(res2.statusCode).toBe(200);
      const body2 = JSON.parse(res2.body);

      const expectedNewRecovered = (BigInt(initialRecovered) + 30000n).toString();
      expect(body2.financial.revenue_recovered_minor).toBe(expectedNewRecovered);
    });
  });

  describe("10. RBAC Security Matrix", () => {
    it("rejects unauthenticated requests with 401 UNAUTHENTICATED", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/analytics/summary",
      });
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("UNAUTHENTICATED");
    });
  });
});
