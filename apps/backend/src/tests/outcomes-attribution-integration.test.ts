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
  listCaseEvents,
  findCaseById,
  type Tenant,
} from "@repo/db";
import { sha256 } from "../lib/crypto";
import { OutcomeRecordService } from "../modules/outcomes/record.service";
import { AttributionSweeper } from "../modules/outcomes/attribution.sweeper";
import { CostCompletenessJob, MESSAGING_UNIT_COSTS_PAISE } from "../modules/outcomes/cost-completeness.job";

describe("Step 26 Integration: Outcomes, Attribution & Cost Model", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let eventBus: InProcessEventBus;
  let tenantA: Tenant;
  let tenantB: Tenant;

  let viewerCookie: string;
  let financeCookie: string;
  let adminCookie: string;
  let recordService: OutcomeRecordService;
  let attributionSweeper: AttributionSweeper;
  let costCompletenessJob: CostCompletenessJob;

  beforeAll(async () => {
    eventBus = new InProcessEventBus();
    app = await buildApp({
      customDb: db,
      eventBus,
      disableRateLimit: true,
    });
    await app.ready();

    recordService = new OutcomeRecordService(db, app.repos);
    attributionSweeper = new AttributionSweeper(db, app.repos);
    costCompletenessJob = new CostCompletenessJob(db, app.repos);

    // 1. Seed Tenants
    tenantA = await createTenant(
      { db },
      { name: `Outcomes Tenant A ${randomUUID()}`, slug: `tenant-out-a-${randomUUID().slice(0, 8)}` },
    );
    tenantB = await createTenant(
      { db },
      { name: `Outcomes Tenant B ${randomUUID()}`, slug: `tenant-out-b-${randomUUID().slice(0, 8)}` },
    );

    // 2. Seed Users & Sessions for Tenant A
    const viewerUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `viewer-${randomUUID().slice(0, 8)}@example.com`,
        name: "Viewer User",
        passwordHash: "mock_hash",
        role: "VIEWER",
      },
    );
    const viewerToken = `session-viewer-${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: viewerUser.id,
        tokenHash: sha256(viewerToken),
        expiresAt: new Date(Date.now() + 86400000),
      },
    );
    viewerCookie = `rr_session=${viewerToken}`;

    const financeUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `finance-${randomUUID().slice(0, 8)}@example.com`,
        name: "Finance User",
        passwordHash: "mock_hash",
        role: "FINANCE",
      },
    );
    const financeToken = `session-finance-${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: financeUser.id,
        tokenHash: sha256(financeToken),
        expiresAt: new Date(Date.now() + 86400000),
      },
    );
    financeCookie = `rr_session=${financeToken}`;

    const adminUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `admin-${randomUUID().slice(0, 8)}@example.com`,
        name: "Admin User",
        passwordHash: "mock_hash",
        role: "ADMIN",
      },
    );
    const adminToken = `session-admin-${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: adminUser.id,
        tokenHash: sha256(adminToken),
        expiresAt: new Date(Date.now() + 86400000),
      },
    );
    adminCookie = `rr_session=${adminToken}`;
  });

  describe("1. recordOutcome Service & Idempotency", () => {
    it("records authoritative outcome, transitions case to RECOVERED, and logs timeline event", async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cust_${randomUUID()}`,
          name: "Happy Path Customer",
          email: "happy@example.com",
        },
      );

      const payment = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          amount: 150000n, // ₹1,500.00
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: `pi_${randomUUID()}`,
          occurredAt: new Date(),
        },
      );

      const caseRecord = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: payment.id,
          amountAtRisk: 150000n,
          currency: "INR",
          riskScore: 75,
          status: "IN_PROGRESS",
        },
      );

      // Record cost entry prior to outcome
      await recordCostEntry(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRecord.id,
          category: "MESSAGING",
          amount: 50n, // ₹0.50 WhatsApp
          currency: "INR",
          incurredAt: new Date(),
        },
      );

      // 1. First recordOutcome call
      const res1 = await recordService.recordOutcome({
        tenantId: tenantA.id,
        caseId: caseRecord.id,
        paymentId: payment.id,
        attributionMethod: "WORKFLOW_LINKED",
      });

      expect(res1.alreadyRecorded).toBe(false);
      expect(res1.outcome.caseId).toBe(caseRecord.id);
      expect(res1.outcome.paymentId).toBe(payment.id);
      expect(res1.outcome.recoveredAmount).toBe(150000n);
      expect(res1.outcome.recoveryCost).toBe(50n);
      expect(res1.outcome.netRecovered).toBe(149950n);
      expect(res1.outcome.attributionMethod).toBe("WORKFLOW_LINKED");

      // Verify case status transitioned to RECOVERED
      const updatedCase = await findCaseById({ db }, { tenantId: tenantA.id, caseId: caseRecord.id });
      expect(updatedCase?.status).toBe("RECOVERED");
      expect(updatedCase?.closedAt).toBeDefined();

      // Verify timeline event
      const events = await listCaseEvents({ db }, { tenantId: tenantA.id, caseId: caseRecord.id });
      const recoveryEvent = events.find((e) => e.eventType === "RECOVERY_RECORDED");
      expect(recoveryEvent).toBeDefined();
      expect(recoveryEvent?.payload).toMatchObject({
        outcomeId: res1.outcome.id,
        recoveredAmount: "150000",
        recoveryCost: "50",
        netRecovered: "149950",
        attributionMethod: "WORKFLOW_LINKED",
      });

      // 2. Idempotent second call with same caseId
      const res2 = await recordService.recordOutcome({
        tenantId: tenantA.id,
        caseId: caseRecord.id,
        paymentId: payment.id,
        attributionMethod: "WORKFLOW_LINKED",
      });

      expect(res2.alreadyRecorded).toBe(true);
      expect(res2.outcome.id).toBe(res1.outcome.id);

      // 3. Competing payment call returns original outcome without modifying
      const competingPayment = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          amount: 200000n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: `pi_competing_${randomUUID()}`,
          occurredAt: new Date(),
        },
      );

      const res3 = await recordService.recordOutcome({
        tenantId: tenantA.id,
        caseId: caseRecord.id,
        paymentId: competingPayment.id,
      });

      expect(res3.alreadyRecorded).toBe(true);
      expect(res3.outcome.id).toBe(res1.outcome.id);
      expect(res3.outcome.paymentId).toBe(payment.id); // preserved original payment
    });

    it("RECOVERED wins over STOPPED for live WORKFLOW_LINKED but STOPPED persists for ATTRIBUTION_WINDOW (race precedence)", async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cust_race_${randomUUID()}`,
          name: "Race Customer",
          email: "race@example.com",
        },
      );

      // Live race: STOPPED case + WORKFLOW_LINKED recovery -> RECOVERED wins
      const livePayment = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          amount: 120000n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: `pi_race_live_${randomUUID()}`,
          occurredAt: new Date(),
        },
      );
      const stoppedLiveCase = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: livePayment.id,
          amountAtRisk: 120000n,
          currency: "INR",
          riskScore: 70,
          status: "STOPPED",
          statusReason: "CUSTOMER_REQUESTED",
        },
      );
      const liveRes = await recordService.recordOutcome({
        tenantId: tenantA.id,
        caseId: stoppedLiveCase.id,
        paymentId: livePayment.id,
        attributionMethod: "WORKFLOW_LINKED",
      });
      expect(liveRes.alreadyRecorded).toBe(false);
      const liveAfter = await findCaseById({ db }, { tenantId: tenantA.id, caseId: stoppedLiveCase.id });
      expect(liveAfter?.status).toBe("RECOVERED");

      // Late attribution: STOPPED case + ATTRIBUTION_WINDOW -> stays STOPPED, outcome still counted
      const latePayment = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          amount: 90000n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: `pi_race_late_${randomUUID()}`,
          occurredAt: new Date(),
        },
      );
      const stoppedLateCase = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: latePayment.id,
          amountAtRisk: 90000n,
          currency: "INR",
          riskScore: 60,
          status: "STOPPED",
          statusReason: "MAX_RETRIES_EXCEEDED",
        },
      );
      const lateRes = await recordService.recordOutcome({
        tenantId: tenantA.id,
        caseId: stoppedLateCase.id,
        paymentId: latePayment.id,
        attributionMethod: "ATTRIBUTION_WINDOW",
      });
      expect(lateRes.alreadyRecorded).toBe(false);
      const lateAfter = await findCaseById({ db }, { tenantId: tenantA.id, caseId: stoppedLateCase.id });
      expect(lateAfter?.status).toBe("STOPPED");
      expect(lateRes.outcome.recoveredAmount).toBe(90000n);
    });
  });

  describe("2. Recovery Cost Rollup Math & Zero-Cost Edge Case", () => {
    it("correctly rolls up multiple cost categories (LLM + messaging + processing) and handles zero-cost cases", async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cust_costs_${randomUUID()}`,
          name: "Cost Test Customer",
          email: "costs@example.com",
        },
      );

      // Case 1: Multi-category costs
      const payment1 = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          amount: 500000n, // ₹5,000.00
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: `pi_multi_${randomUUID()}`,
          occurredAt: new Date(),
        },
      );

      const case1 = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: payment1.id,
          amountAtRisk: 500000n,
          currency: "INR",
          riskScore: 80,
          status: "IN_PROGRESS",
        },
      );

      // Add 3 separate cost entries: LLM (120 paise), Messaging (50 paise), Processing (200 paise)
      await recordCostEntry({ db }, {
        tenantId: tenantA.id,
        caseId: case1.id,
        category: "LLM",
        amount: 120n,
        currency: "INR",
        incurredAt: new Date(),
      });
      await recordCostEntry({ db }, {
        tenantId: tenantA.id,
        caseId: case1.id,
        category: "MESSAGING",
        amount: 50n,
        currency: "INR",
        incurredAt: new Date(),
      });
      await recordCostEntry({ db }, {
        tenantId: tenantA.id,
        caseId: case1.id,
        category: "PAYMENT_PROCESSING",
        amount: 200n,
        currency: "INR",
        incurredAt: new Date(),
      });

      const res1 = await recordService.recordOutcome({
        tenantId: tenantA.id,
        caseId: case1.id,
        paymentId: payment1.id,
      });

      expect(res1.outcome.recoveryCost).toBe(370n); // 120 + 50 + 200 = 370
      expect(res1.outcome.recoveredAmount).toBe(500000n);
      expect(res1.outcome.netRecovered).toBe(499630n); // 500000 - 370 = 499630

      // Case 2: Zero-cost edge case
      const payment2 = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          amount: 250000n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: `pi_zero_${randomUUID()}`,
          occurredAt: new Date(),
        },
      );

      const case2 = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "INVOICE_OVERDUE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: payment2.id,
          amountAtRisk: 250000n,
          currency: "INR",
          riskScore: 40,
          status: "IN_PROGRESS",
        },
      );

      const res2 = await recordService.recordOutcome({
        tenantId: tenantA.id,
        caseId: case2.id,
        paymentId: payment2.id,
      });

      expect(res2.outcome.recoveryCost).toBe(0n);
      expect(res2.outcome.recoveredAmount).toBe(250000n);
      expect(res2.outcome.netRecovered).toBe(250000n);
    });
  });

  describe("3. Attribution Sweeper (ATTRIBUTION_WINDOW) & 4 Conditions", () => {
    it("attributes late payment within attribution window to STOPPED case and ignores payments outside window", async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cust_sweep_${randomUUID()}`,
          name: "Sweeper Customer",
          email: "sweep@example.com",
        },
      );

      const now = Date.now();
      const t0 = new Date(now - 48 * 3600 * 1000); // 48h ago

      // 1. Valid Late Payment Case (within 72h window)
      const paymentInside = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          amount: 80000n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "RAZORPAY",
          providerPaymentId: `pay_inside_${randomUUID()}`,
          occurredAt: new Date(now - 24 * 3600 * 1000), // 24h after t0 -> inside 72h window
        },
      );

      const caseInside = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: paymentInside.id,
          amountAtRisk: 80000n,
          currency: "INR",
          riskScore: 60,
          status: "STOPPED",
          statusReason: "MAX_RETRIES_EXCEEDED",
          attributionWindowHours: 72,
          openedAt: t0,
          closedAt: new Date(now - 40 * 3600 * 1000),
        },
      );

      // 2. Expired Payment Case (outside 72h window)
      const tOld = new Date(now - 120 * 3600 * 1000); // 120h ago
      const paymentOutside = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          amount: 90000n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "RAZORPAY",
          providerPaymentId: `pay_outside_${randomUUID()}`,
          occurredAt: new Date(now - 20 * 3600 * 1000), // 100h after tOld -> exceeds 72h window
        },
      );

      const caseOutside = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: paymentOutside.id,
          amountAtRisk: 90000n,
          currency: "INR",
          riskScore: 60,
          status: "STOPPED",
          statusReason: "MAX_RETRIES_EXCEEDED",
          attributionWindowHours: 72,
          openedAt: tOld,
          closedAt: new Date(now - 100 * 3600 * 1000),
        },
      );

      // Run Attribution Sweeper
      const sweepResult = await attributionSweeper.runSweep({ tenantId: tenantA.id });

      expect(sweepResult.casesAudited).toBeGreaterThanOrEqual(2);
      expect(sweepResult.attributedCaseIds).toContain(caseInside.id);
      expect(sweepResult.attributedCaseIds).not.toContain(caseOutside.id);

      // Verify caseInside has outcome with ATTRIBUTION_WINDOW
      const outcomeInside = await app.repos.findOutcomeByCaseId(
        { db },
        { tenantId: tenantA.id, caseId: caseInside.id },
      );
      expect(outcomeInside).toBeDefined();
      expect(outcomeInside?.attributionMethod).toBe("ATTRIBUTION_WINDOW");
      expect(outcomeInside?.recoveredAmount).toBe(80000n);

      // Contract Test: Case status remains STOPPED (closed cases are never reopened)
      const caseInsideAfter = await findCaseById({ db }, { tenantId: tenantA.id, caseId: caseInside.id });
      expect(caseInsideAfter?.status).toBe("STOPPED");

      // Verify caseOutside does NOT have an outcome
      const outcomeOutside = await app.repos.findOutcomeByCaseId(
        { db },
        { tenantId: tenantA.id, caseId: caseOutside.id },
      );
      expect(outcomeOutside).toBeNull();
    });

    it("blocks attribution when a competing live case owns the same financial obligation (Condition 4)", async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cust_compete_${randomUUID()}`,
          name: "Competing Case Customer",
          email: "compete@example.com",
        },
      );

      // Payment occurs for this obligation
      const sharedPayment = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          amount: 300000n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: `pi_shared_${randomUUID()}`,
          occurredAt: new Date(),
        },
      );
      const sharedPaymentId = sharedPayment.id;

      // Case 1: STOPPED case
      const oldCase = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: sharedPaymentId,
          amountAtRisk: 300000n,
          currency: "INR",
          riskScore: 70,
          status: "STOPPED",
          attributionWindowHours: 72,
          openedAt: new Date(Date.now() - 24 * 3600 * 1000),
        },
      );

      // Case 2: New live case for the exact same source entity
      const newLiveCase = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: sharedPaymentId,
          amountAtRisk: 300000n,
          currency: "INR",
          riskScore: 85,
          status: "IN_PROGRESS",
          attributionWindowHours: 72,
          openedAt: new Date(),
        },
      );

      // Sweeper runs
      const sweepResult = await attributionSweeper.runSweep({ tenantId: tenantA.id });

      // Old case should NOT be attributed because newLiveCase is active and owns the obligation
      expect(sweepResult.attributedCaseIds).not.toContain(oldCase.id);

      const oldOutcome = await app.repos.findOutcomeByCaseId(
        { db },
        { tenantId: tenantA.id, caseId: oldCase.id },
      );
      expect(oldOutcome).toBeNull();
    });
  });

  describe("4. Cost Completeness Audit Job", () => {
    it("audits executed actions, detects missing cost entries, and remediates them accurately", async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cust_audit_${randomUUID()}`,
          name: "Audit Job Customer",
          email: "audit@example.com",
        },
      );

      const caseRecord = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "CHECKOUT_ABANDONMENT",
          sourceEntityType: "CHECKOUT",
          sourceEntityId: randomUUID(),
          amountAtRisk: 100000n,
          currency: "INR",
          riskScore: 50,
          status: "IN_PROGRESS",
        },
      );

      // Insert 2 EXECUTED messaging actions without cost entries
      const actionWA = await insertAction(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRecord.id,
          type: "SEND_WHATSAPP",
          parameters: { template: "recovery_offer_v1" },
          status: "EXECUTED",
          attemptNumber: 1,
          idempotencyKey: `${tenantA.id}:${caseRecord.id}:SEND_WHATSAPP:1`,
          completedAt: new Date(),
        },
      );

      const actionEmail = await insertAction(
        { db },
        {
          tenantId: tenantA.id,
          caseId: caseRecord.id,
          type: "SEND_EMAIL",
          parameters: { template: "cart_reminder_en" },
          status: "EXECUTED",
          attemptNumber: 1,
          idempotencyKey: `${tenantA.id}:${caseRecord.id}:SEND_EMAIL:1`,
          completedAt: new Date(),
        },
      );

      // Run Cost Completeness Job
      const auditResult = await costCompletenessJob.runAudit({ tenantId: tenantA.id });

      expect(auditResult.actionsAudited).toBeGreaterThanOrEqual(2);
      expect(auditResult.remediatedActionIds).toContain(actionWA.id);
      expect(auditResult.remediatedActionIds).toContain(actionEmail.id);

      // Verify cost entries were recorded with authoritative pricing
      const costEntries = await app.repos.listCostEntriesForCase(
        { db },
        { tenantId: tenantA.id, caseId: caseRecord.id },
      );

      const waCost = costEntries.find((c) => (c.metadata as any)?.action_id === actionWA.id);
      expect(waCost).toBeDefined();
      expect(waCost?.amount).toBe(MESSAGING_UNIT_COSTS_PAISE.SEND_WHATSAPP); // 50 paise
      expect(waCost?.category).toBe("MESSAGING");

      const emailCost = costEntries.find((c) => (c.metadata as any)?.action_id === actionEmail.id);
      expect(emailCost).toBeDefined();
      expect(emailCost?.amount).toBe(MESSAGING_UNIT_COSTS_PAISE.SEND_EMAIL); // 5 paise
      expect(emailCost?.category).toBe("MESSAGING");

      // Running second audit detects 0 gaps (idempotent)
      const auditResult2 = await costCompletenessJob.runAudit({ tenantId: tenantA.id });
      expect(auditResult2.remediatedActionIds).not.toContain(actionWA.id);
      expect(auditResult2.remediatedActionIds).not.toContain(actionEmail.id);
    });
  });

  describe("5. Outcome Read REST APIs (GET /outcomes, GET /cases/:id/outcome)", () => {
    it("GET /cases/:id/outcome returns outcome record or 404 NO_OUTCOME", async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cust_api_${randomUUID()}`,
          name: "API Customer",
          email: "api@example.com",
        },
      );

      const payment = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          amount: 200000n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: `pi_api_${randomUUID()}`,
          occurredAt: new Date(),
        },
      );

      const caseWithOutcome = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: payment.id,
          amountAtRisk: 200000n,
          currency: "INR",
          riskScore: 70,
          status: "IN_PROGRESS",
        },
      );

      const caseWithoutOutcome = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          amountAtRisk: 100000n,
          currency: "INR",
          riskScore: 50,
          status: "IN_PROGRESS",
        },
      );

      await recordService.recordOutcome({
        tenantId: tenantA.id,
        caseId: caseWithOutcome.id,
        paymentId: payment.id,
      });

      // 1. Success on case with outcome
      const res1 = await app.inject({
        method: "GET",
        url: `/cases/${caseWithOutcome.id}/outcome`,
        headers: {
          cookie: viewerCookie,
        },
      });

      expect(res1.statusCode).toBe(200);
      const body1 = JSON.parse(res1.body);
      expect(body1.case_id).toBe(caseWithOutcome.id);
      expect(body1.payment_id).toBe(payment.id);
      expect(body1.recovered_amount).toBe("200000");
      expect(body1.attribution_method).toBe("WORKFLOW_LINKED");

      // 2. 404 NO_OUTCOME on case without outcome
      const res2 = await app.inject({
        method: "GET",
        url: `/cases/${caseWithoutOutcome.id}/outcome`,
        headers: {
          cookie: viewerCookie,
        },
      });

      expect(res2.statusCode).toBe(404);
      const body2 = JSON.parse(res2.body);
      expect(body2.error?.code).toBe("NO_OUTCOME");

      // 3. Tenant Isolation: Tenant B cannot access Tenant A case outcome (returns 404)
      const tenantBUser = await createUser(
        { db },
        {
          tenantId: tenantB.id,
          email: `viewer-b-${randomUUID().slice(0, 8)}@example.com`,
          name: "Viewer B",
          passwordHash: "mock_hash",
          role: "VIEWER",
        },
      );
      const tokenB = `session-b-${randomUUID()}`;
      await createSession(
        { db },
        {
          userId: tenantBUser.id,
          tokenHash: sha256(tokenB),
          expiresAt: new Date(Date.now() + 86400000),
        },
      );

      const res3 = await app.inject({
        method: "GET",
        url: `/cases/${caseWithOutcome.id}/outcome`,
        headers: {
          cookie: `rr_session=${tokenB}`,
        },
      });

      expect(res3.statusCode).toBe(404);
    });

    it("GET /outcomes returns filtered outcomes, cursor pagination, and authoritative SQL aggregates", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/outcomes?limit=10",
        headers: {
          cookie: financeCookie,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);

      expect(Array.isArray(body.items)).toBe(true);
      expect(body.aggregates).toBeDefined();
      expect(typeof body.aggregates.recovered_minor).toBe("string");
      expect(typeof body.aggregates.cost_minor).toBe("string");
      expect(typeof body.aggregates.net_minor).toBe("string");
      expect(typeof body.aggregates.count).toBe("number");
      expect(body.aggregates.count).toBeGreaterThanOrEqual(1);

      // Verify aggregate math on payload
      const rec = BigInt(body.aggregates.recovered_minor);
      const cost = BigInt(body.aggregates.cost_minor);
      const net = BigInt(body.aggregates.net_minor);
      expect(net).toBe(rec - cost);

      // Test Method Filter
      const resFiltered = await app.inject({
        method: "GET",
        url: "/outcomes?method=ATTRIBUTION_WINDOW",
        headers: {
          cookie: viewerCookie,
        },
      });

      expect(resFiltered.statusCode).toBe(200);
      const bodyFiltered = JSON.parse(resFiltered.body);
      for (const item of bodyFiltered.items) {
        expect(item.attribution_method).toBe("ATTRIBUTION_WINDOW");
      }
    });

    it("enforces RBAC role matrix on outcomes endpoints", async () => {
      // Unauthenticated -> 401
      const resUnauth = await app.inject({
        method: "GET",
        url: "/outcomes",
      });
      expect(resUnauth.statusCode).toBe(401);

      // VIEWER role -> 200
      const resViewer = await app.inject({
        method: "GET",
        url: "/outcomes",
        headers: {
          cookie: viewerCookie,
        },
      });
      expect(resViewer.statusCode).toBe(200);

      // ADMIN role -> 200
      const resAdmin = await app.inject({
        method: "GET",
        url: "/outcomes",
        headers: {
          cookie: adminCookie,
        },
      });
      expect(resAdmin.statusCode).toBe(200);
    });

    it("GET /outcomes/cases/:id alias mirrors canonical outcome (200/404/tenant-404)", async () => {
      // Canonical is GET /cases/:id/outcome; this alias is kept for compat (see routes.ts).
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cust_alias_${randomUUID()}`,
          name: "Alias Customer",
          email: "alias@example.com",
        },
      );
      const payment = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          amount: 77700n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: `pi_alias_${randomUUID()}`,
          occurredAt: new Date(),
        },
      );
      const caseWithOutcome = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: payment.id,
          amountAtRisk: 77700n,
          currency: "INR",
          riskScore: 60,
          status: "IN_PROGRESS",
        },
      );
      const caseWithoutOutcome = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          amountAtRisk: 11100n,
          currency: "INR",
          riskScore: 40,
          status: "IN_PROGRESS",
        },
      );
      await recordService.recordOutcome({
        tenantId: tenantA.id,
        caseId: caseWithOutcome.id,
        paymentId: payment.id,
      });

      // 200 for owner via alias
      const res200 = await app.inject({
        method: "GET",
        url: `/outcomes/cases/${caseWithOutcome.id}`,
        headers: { cookie: viewerCookie },
      });
      expect(res200.statusCode).toBe(200);
      expect(JSON.parse(res200.body).case_id).toBe(caseWithOutcome.id);

      // 404 NO_OUTCOME for case without outcome via alias
      const res404 = await app.inject({
        method: "GET",
        url: `/outcomes/cases/${caseWithoutOutcome.id}`,
        headers: { cookie: viewerCookie },
      });
      expect(res404.statusCode).toBe(404);
      expect(JSON.parse(res404.body).error?.code).toBe("NO_OUTCOME");

      // Tenant isolation: Tenant B gets 404 on Tenant A case via alias
      const tenantBUser = await createUser(
        { db },
        {
          tenantId: tenantB.id,
          email: `alias-b-${randomUUID().slice(0, 8)}@example.com`,
          name: "Alias B",
          passwordHash: "mock_hash",
          role: "VIEWER",
        },
      );
      const tokenB = `session-alias-b-${randomUUID()}`;
      await createSession(
        { db },
        {
          userId: tenantBUser.id,
          tokenHash: sha256(tokenB),
          expiresAt: new Date(Date.now() + 86400000),
        },
      );
      const resTenant404 = await app.inject({
        method: "GET",
        url: `/outcomes/cases/${caseWithOutcome.id}`,
        headers: { cookie: `rr_session=${tokenB}` },
      });
      expect(resTenant404.statusCode).toBe(404);
    });
  });
});
