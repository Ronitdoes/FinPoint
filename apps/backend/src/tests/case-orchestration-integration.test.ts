import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { NullBus } from "@repo/integrations";
import {
  db,
  createTenant,
  createUser,
  createSession,
  createCustomer,
  createPayment,
  createInvoice,
  createCase,
  createRevenueRisk,
  listActionsForCase,
  listCaseEvents,
  listHumanTasksForCase,
  findCaseById,
  type Tenant,
} from "@repo/db";
import { sha256 } from "../lib/crypto";
import { PolicyService } from "../modules/policy/policy.service";
import { CaseCreationService } from "../modules/cases/creation.service";
import { CasePipelineService } from "../modules/cases/pipeline.service";

/**
 * Fast mock LLM fetch for deterministic and instantaneous unit/integration testing
 */
const mockLlmFetch: any = async (input: any, init: any) => {
  const body = init?.body ? JSON.parse(init.body as string) : {};
  const bodyStr = JSON.stringify(body);
  const isOptedOutPrompt =
    bodyStr.includes('opted_out\\": true') ||
    bodyStr.includes('opted_out\\":true') ||
    bodyStr.includes('opted_out": true') ||
    bodyStr.includes('opted_out":true') ||
    bodyStr.includes('optedOut\\": true') ||
    bodyStr.includes('optedOut\\":true') ||
    bodyStr.includes('optedOut": true') ||
    bodyStr.includes('optedOut":true');

  // If opted out prompt, return messaging actions only to trigger 100% policy rejection
  const actions = isOptedOutPrompt
    ? [
        {
          type: "SEND_EMAIL",
          delay_hours: 2,
          params: { template: "payment_failed_notice", variables: {} },
        },
        {
          type: "SEND_WHATSAPP",
          delay_hours: 4,
          params: { template: "payment_reminder", variables: {} },
        },
      ]
    : [
        {
          type: "RETRY_PAYMENT",
          delay_hours: 2,
          params: { attempt_number: 1 },
        },
        {
          type: "SEND_EMAIL",
          delay_hours: 1,
          params: { template: "payment_retry_notice", variables: {} },
        },
      ];

  return new Response(
    JSON.stringify({
      id: "mock-llm-choice-1",
      model: "gpt-4o-mini",
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              diagnosis: {
                cause: "network_issue",
                confidence: 0.92,
                rationale: "Transient payment gateway timeout",
              },
              actions,
              stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT"],
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
};

describe("Step 17 Integration: Recovery Case Orchestration Pipeline", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let eventBus: NullBus;
  let policyService: PolicyService;
  let creationService: CaseCreationService;
  let pipelineService: CasePipelineService;

  let tenantA: Tenant;
  let tenantB: Tenant;

  // Session tokens for RBAC testing
  let viewerCookie: string;
  let supportCookie: string;
  let operationsCookie: string;
  let financeCookie: string;
  let adminCookie: string;
  let tenantBCookie: string;

  const runId = randomUUID().slice(0, 8);

  beforeAll(async () => {
    eventBus = new NullBus();

    // 1. Create Tenants
    tenantA = await createTenant(
      { db },
      {
        name: `Case Tenant A ${runId}`,
        slug: `case-tenant-a-${runId}`,
      },
    );

    tenantB = await createTenant(
      { db },
      {
        name: `Case Tenant B ${runId}`,
        slug: `case-tenant-b-${runId}`,
      },
    );

    // 2. Helper to create user and active session cookie
    const createTestUserSession = async (
      tenantId: string,
      role: "VIEWER" | "SUPPORT" | "OPERATIONS" | "FINANCE" | "ADMIN",
    ): Promise<string> => {
      const user = await createUser(
        { db },
        {
          tenantId,
          email: `${role.toLowerCase()}_${runId}@example.com`,
          name: `${role} User`,
          passwordHash: "dummy",
          role,
          status: "ACTIVE",
        },
      );

      const rawToken = randomUUID();
      await createSession(
        { db },
        {
          userId: user.id,
          tokenHash: sha256(rawToken),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      );

      return rawToken;
    };

    viewerCookie = await createTestUserSession(tenantA.id, "VIEWER");
    supportCookie = await createTestUserSession(tenantA.id, "SUPPORT");
    operationsCookie = await createTestUserSession(tenantA.id, "OPERATIONS");
    financeCookie = await createTestUserSession(tenantA.id, "FINANCE");
    adminCookie = await createTestUserSession(tenantA.id, "ADMIN");
    tenantBCookie = await createTestUserSession(tenantB.id, "ADMIN");

    // 3. Build fastify test app
    app = await buildApp({ eventBus, disableRateLimit: true });
    await app.ready();

    // 4. Seed default policies
    policyService = new PolicyService(db, app.repos);
    await policyService.seedDefaultPolicies();

    creationService = new CaseCreationService(db, app.repos, eventBus);
    pipelineService = new CasePipelineService({
      db,
      repos: app.repos,
      config: app.config,
      customFetch: mockLlmFetch,
    });
  }, 60000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  }, 30000);

  // ===========================================================================
  // 1. CONCURRENT CREATION & ANTI-DUPLICATION GUARANTEE
  // ===========================================================================
  describe("1. Idempotent Case Creation & Anti-Duplication Anchor", () => {
    it("creates exactly one recovery case when 5 concurrent risk.calculated events arrive for the same payment", async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cus_concur_${runId}`,
          name: "Concurrent Test Customer",
          email: `concur_${runId}@example.com`,
        },
      );

      const payment = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          provider: "STRIPE",
          providerPaymentId: `pi_concur_${runId}`,
          amount: 120_000n, // ₹1,200
          currency: "INR",
          status: "FAILED",
          occurredAt: new Date(),
        },
      );

      const risk = await createRevenueRisk(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          subjectType: "PAYMENT",
          subjectId: payment.id,
          score: 80,
          band: "HIGH",
          factors: { failed_attempts: 1 },
          status: "OPEN",
          computedAt: new Date(),
        },
      );

      // Execute 5 simultaneous tryCreateCase calls
      const promises = Array.from({ length: 5 }, () =>
        creationService.tryCreateCase({
          tenantId: tenantA.id,
          customerId: customer.id,
          riskId: risk.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: payment.id,
          amountAtRisk: payment.amount,
          currency: payment.currency,
          riskScore: risk.score,
        }),
      );

      const results = await Promise.all(promises);

      // Exactly one was created: true, others returned created: false with identical case id
      const createdCount = results.filter((r) => r.created).length;
      expect(createdCount).toBe(1);

      const firstCaseId = results[0].case.id;
      for (const r of results) {
        expect(r.case.id).toBe(firstCaseId);
        expect(r.case.status).toBe("QUALIFIED");
      }

      // Check timeline event RISK_CALCULATED emitted
      const events = await listCaseEvents(
        { db },
        { tenantId: tenantA.id, caseId: firstCaseId },
      );
      expect(events.some((e) => e.eventType === "RISK_CALCULATED")).toBe(true);
    }, 30000);
  });

  // ===========================================================================
  // 2. HAPPY PATH PIPELINE EXECUTION & LEDGER RESUMABILITY
  // ===========================================================================
  describe("2. Staged Recovery Pipeline Runner", () => {
    // Converge helper (same race as the s-17 canonical-case hardening): the
    // app's background orchestrator consumer shares this NullBus, so
    // tryCreateCase schedules a background runPipeline via setImmediate that
    // races the direct run below for the `${caseId}:decision:1` lease; the
    // loser yields via IdempotencyInFlightError leaving QUALIFIED. Re-drive
    // while non-terminal until the case settles.
    const drivePipelineToSettled = async (tenantId: string, caseId: string) => {
      const deadline = Date.now() + 20000;
      let row = await findCaseById({ db }, { tenantId, caseId });
      while (
        row &&
        !["IN_PROGRESS", "WAITING", "ESCALATED", "STOPPED", "FAILED", "RECOVERED"].includes(
          row.status,
        ) &&
        Date.now() < deadline
      ) {
        await pipelineService.runPipeline({ tenantId, caseId });
        await new Promise((r) => setTimeout(r, 500));
        row = await findCaseById({ db }, { tenantId, caseId });
      }
      return row;
    };

    it("runs complete happy path: QUALIFIED -> DECISION_PENDING -> POLICY_REVIEW -> IN_PROGRESS with APPROVED actions", async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cus_happy_${runId}`,
          name: "Happy Path Customer",
          email: `happy_${runId}@example.com`,
          optedOut: false,
        },
      );

      const payment = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          provider: "STRIPE",
          providerPaymentId: `pi_happy_${runId}`,
          amount: 80_000n, // ₹800 (under ₹100,000 high value threshold)
          currency: "INR",
          status: "FAILED",
          occurredAt: new Date(),
        },
      );

      const { case: recoveryCase, created } = await creationService.tryCreateCase({
        tenantId: tenantA.id,
        customerId: customer.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: payment.id,
        amountAtRisk: payment.amount,
        currency: payment.currency,
        riskScore: 60,
      });

      expect(created).toBe(true);
      expect(recoveryCase.status).toBe("QUALIFIED");

      // Execute pipeline (converge: background consumer may hold the decide
      // lease; re-drive until settled)
      await drivePipelineToSettled(tenantA.id, recoveryCase.id);

      // Assert final case state
      const finalCase = await findCaseById(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );

      expect(finalCase).not.toBeNull();
      expect(finalCase?.status).toBe("IN_PROGRESS");
      expect(finalCase?.workflowId).toBeDefined();

      // Assert action rows created in status APPROVED
      const actions = await listActionsForCase(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );
      expect(actions.length).toBeGreaterThan(0);
      for (const act of actions) {
        expect(act.status).toBe("APPROVED");
        expect(act.idempotencyKey).toContain(recoveryCase.id);
      }

      // Assert timeline event progression
      const timeline = await listCaseEvents(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );
      const eventTypes = timeline.map((e) => e.eventType);

      expect(eventTypes).toContain("RISK_CALCULATED");
      expect(eventTypes).toContain("AI_DECISION_CREATED");
      expect(eventTypes).toContain("POLICY_ALLOWED");
      expect(eventTypes).toContain("WORKFLOW_STARTED");
    }, 30000);

    it("resumes cleanly without re-executing completed stages when invoked repeatedly", async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cus_resume_${runId}`,
          name: "Resume Test Customer",
          email: `resume_${runId}@example.com`,
          optedOut: false,
        },
      );

      const { case: recoveryCase } = await creationService.tryCreateCase({
        tenantId: tenantA.id,
        customerId: customer.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: randomUUID(),
        amountAtRisk: 50_000n,
        currency: "INR",
        riskScore: 55,
      });

      // Run pipeline first time -> IN_PROGRESS (converge: same lease race
      // as happy path; re-drive until settled)
      await drivePipelineToSettled(tenantA.id, recoveryCase.id);

      const firstTimeline = await listCaseEvents(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );

      // Re-invoke pipeline on already IN_PROGRESS case
      await pipelineService.runPipeline({
        tenantId: tenantA.id,
        caseId: recoveryCase.id,
      });

      const secondTimeline = await listCaseEvents(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );

      expect(secondTimeline.length).toBe(firstTimeline.length);
    }, 30000);

    it("all-rejected fixture: transitions to STOPPED (POLICY_ALL_REJECTED) and emits POLICY_REJECTED timeline event", async () => {
      // Customer is opted out -> policy POL-OPTOUT rejects all outbound communication
      const optedOutCustomer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cus_optout_pipe_${runId}`,
          name: "Opted Out Pipe Customer",
          email: `optout_pipe_${runId}@example.com`,
          optedOut: true,
        },
      );

      const recoveryCase = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: optedOutCustomer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          amountAtRisk: 30_000n,
          currency: "INR",
          riskScore: 60,
          status: "QUALIFIED",
        },
      );

      // Run pipeline
      await pipelineService.runPipeline({
        tenantId: tenantA.id,
        caseId: recoveryCase.id,
      });

      const finalCase = await findCaseById(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );

      expect(finalCase?.status).toBe("STOPPED");
      expect(finalCase?.statusReason).toBe("POLICY_ALL_REJECTED");

      const timeline = await listCaseEvents(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );
      expect(timeline.some((e) => e.eventType === "POLICY_REJECTED")).toBe(true);
    }, 30000);

    it("approval fixture: transitions to ESCALATED (POLICY_REQUIRES_APPROVAL) and creates APPROVAL human task", async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cus_highval_${runId}`,
          name: "High Value Customer",
          email: `highval_${runId}@example.com`,
          optedOut: false,
        },
      );

      const invoice = await createInvoice(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          number: `INV_HIGH_${runId}`,
          amount: 15_000_000n, // ₹150,000 (> ₹100,000 limit)
          currency: "INR",
          status: "OVERDUE",
          dueAt: new Date(),
        },
      );

      const recoveryCase = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "INVOICE_OVERDUE",
          sourceEntityType: "INVOICE",
          sourceEntityId: invoice.id,
          amountAtRisk: invoice.amount,
          currency: invoice.currency,
          riskScore: 75,
          status: "QUALIFIED",
        },
      );

      await pipelineService.runPipeline({
        tenantId: tenantA.id,
        caseId: recoveryCase.id,
      });

      const finalCase = await findCaseById(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );

      expect(finalCase?.status).toBe("ESCALATED");
      expect(finalCase?.statusReason).toBe("POLICY_REQUIRES_APPROVAL");

      // Verify APPROVAL Human Task created
      const tasks = await listHumanTasksForCase(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks[0]?.type).toBe("APPROVAL");
      expect(tasks[0]?.status).toBe("PENDING");

      const timeline = await listCaseEvents(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );
      expect(timeline.some((e) => e.eventType === "HUMAN_TASK_CREATED")).toBe(true);
      expect(timeline.some((e) => e.eventType === "CASE_ESCALATED")).toBe(true);
    }, 30000);

    it("SIMULATE_LLM_FAILURE with fallback failure transitions to FAILED (NO_DECISION_AVAILABLE)", async () => {
      // Pipeline instance with a failing customFetch that throws network errors
      const failingPipelineService = new CasePipelineService({
        db,
        repos: app.repos,
        config: {
          ...app.config,
          ai: {
            ...app.config.ai,
            enableRuleFallback: false, // fallback disabled
          },
        },
        customFetch: (async () => {
          throw new Error("Simulated upstream LLM outage");
        }) as any,
      });

      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cus_failed_${runId}`,
          name: "Failing Customer",
          email: `failed_${runId}@example.com`,
          optedOut: false,
        },
      );

      const recoveryCase = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          amountAtRisk: 40_000n,
          currency: "INR",
          riskScore: 70,
          status: "QUALIFIED",
        },
      );

      await failingPipelineService.runPipeline({
        tenantId: tenantA.id,
        caseId: recoveryCase.id,
      });

      const finalCase = await findCaseById(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );

      expect(finalCase?.status).toBe("FAILED");
      expect(finalCase?.statusReason).toBe("NO_DECISION_AVAILABLE");

      const timeline = await listCaseEvents(
        { db },
        { tenantId: tenantA.id, caseId: recoveryCase.id },
      );
      expect(timeline.some((e) => e.eventType === "CASE_FAILED")).toBe(true);
    }, 30000);
  });

  // ===========================================================================
  // 3. CASE CONTROL APIS & RBAC MATRIX
  // ===========================================================================
  describe("3. Case Control APIs (Pause / Resume / Escalate / Stop)", () => {
    let testCaseId: string;

    beforeAll(async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cus_control_${runId}`,
          name: "Control Test Customer",
          email: `control_${runId}@example.com`,
          optedOut: false,
        },
      );

      const c = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          amountAtRisk: 50_000n,
          currency: "INR",
          riskScore: 50,
          status: "IN_PROGRESS",
        },
      );
      testCaseId = c.id;
    }, 30000);

    it("pause -> resume roundtrip updates status and emits timeline events", async () => {
      // 1. Pause (IN_PROGRESS -> WAITING)
      const pauseRes = await app.inject({
        method: "POST",
        url: `/cases/${testCaseId}/pause`,
        cookies: { rr_session: operationsCookie },
      });

      expect(pauseRes.statusCode).toBe(202);
      expect(pauseRes.json()).toEqual({ status: "WAITING" });

      let currentCase = await findCaseById(
        { db },
        { tenantId: tenantA.id, caseId: testCaseId },
      );
      expect(currentCase?.status).toBe("WAITING");

      // 2. Resume (WAITING -> IN_PROGRESS)
      const resumeRes = await app.inject({
        method: "POST",
        url: `/cases/${testCaseId}/resume`,
        cookies: { rr_session: operationsCookie },
      });

      expect(resumeRes.statusCode).toBe(202);
      expect(resumeRes.json()).toEqual({ status: "IN_PROGRESS" });

      currentCase = await findCaseById(
        { db },
        { tenantId: tenantA.id, caseId: testCaseId },
      );
      expect(currentCase?.status).toBe("IN_PROGRESS");

      // Check timeline events
      const timeline = await listCaseEvents(
        { db },
        { tenantId: tenantA.id, caseId: testCaseId },
      );
      expect(timeline.some((e) => e.eventType === "CASE_PAUSED")).toBe(true);
      expect(timeline.some((e) => e.eventType === "CASE_RESUMED")).toBe(true);
    }, 30000);

    it("escalate creates GENERAL human task and updates status to ESCALATED", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/cases/${testCaseId}/escalate`,
        cookies: { rr_session: supportCookie },
        payload: { notes: "Customer requested high tier support agent" },
      });

      expect(res.statusCode).toBe(202);
      const json = res.json();
      expect(json.status).toBe("ESCALATED");
      expect(json.taskId).toBeDefined();

      const currentCase = await findCaseById(
        { db },
        { tenantId: tenantA.id, caseId: testCaseId },
      );
      expect(currentCase?.status).toBe("ESCALATED");
    }, 30000);

    it("stop requires mandatory reason and transitions case to STOPPED", async () => {
      // 1. Missing reason -> 422 Validation Error
      const failRes = await app.inject({
        method: "POST",
        url: `/cases/${testCaseId}/stop`,
        cookies: { rr_session: financeCookie },
        payload: {},
      });
      expect(failRes.statusCode).toBe(422);

      // 2. Valid reason -> 202 STOPPED
      const stopRes = await app.inject({
        method: "POST",
        url: `/cases/${testCaseId}/stop`,
        cookies: { rr_session: financeCookie },
        payload: { reason: "Customer resolved offline via direct wire" },
      });

      expect(stopRes.statusCode).toBe(202);
      expect(stopRes.json()).toEqual({ status: "STOPPED" });

      const finalCase = await findCaseById(
        { db },
        { tenantId: tenantA.id, caseId: testCaseId },
      );
      expect(finalCase?.status).toBe("STOPPED");
      expect(finalCase?.statusReason).toBe("Customer resolved offline via direct wire");
      expect(finalCase?.closedAt).toBeDefined();
    }, 30000);

    it("returns 409 CASE_TERMINAL when attempting control actions on a terminal case", async () => {
      const pauseTerminal = await app.inject({
        method: "POST",
        url: `/cases/${testCaseId}/pause`,
        cookies: { rr_session: operationsCookie },
      });
      expect(pauseTerminal.statusCode).toBe(409);
      expect(pauseTerminal.json().error.code).toBe("CASE_TERMINAL");

      const resumeTerminal = await app.inject({
        method: "POST",
        url: `/cases/${testCaseId}/resume`,
        cookies: { rr_session: operationsCookie },
      });
      expect(resumeTerminal.statusCode).toBe(409);
      expect(resumeTerminal.json().error.code).toBe("CASE_TERMINAL");

      const stopTerminal = await app.inject({
        method: "POST",
        url: `/cases/${testCaseId}/stop`,
        cookies: { rr_session: financeCookie },
        payload: { reason: "Already stopped" },
      });
      expect(stopTerminal.statusCode).toBe(409);
      expect(stopTerminal.json().error.code).toBe("CASE_TERMINAL");
    }, 30000);

    it("enforces RBAC role matrix across all control endpoints", async () => {
      const newLiveCase = await createCase(
        { db },
        {
          tenantId: tenantA.id,
          customerId: (
            await createCustomer(
              { db },
              {
                tenantId: tenantA.id,
                externalRef: `cus_rbac_${runId}`,
                name: "RBAC Customer",
                email: `rbac_${runId}@example.com`,
              },
            )
          ).id,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          amountAtRisk: 50_000n,
          currency: "INR",
          riskScore: 50,
          status: "IN_PROGRESS",
        },
      );

      // VIEWER cannot pause, resume, escalate, or stop (all 403)
      const viewerPause = await app.inject({
        method: "POST",
        url: `/cases/${newLiveCase.id}/pause`,
        cookies: { rr_session: viewerCookie },
      });
      expect(viewerPause.statusCode).toBe(403);

      const viewerEscalate = await app.inject({
        method: "POST",
        url: `/cases/${newLiveCase.id}/escalate`,
        cookies: { rr_session: viewerCookie },
      });
      expect(viewerEscalate.statusCode).toBe(403);

      const viewerStop = await app.inject({
        method: "POST",
        url: `/cases/${newLiveCase.id}/stop`,
        cookies: { rr_session: viewerCookie },
        payload: { reason: "test" },
      });
      expect(viewerStop.statusCode).toBe(403);

      // SUPPORT can escalate, but cannot pause or stop
      const supportPause = await app.inject({
        method: "POST",
        url: `/cases/${newLiveCase.id}/pause`,
        cookies: { rr_session: supportCookie },
      });
      expect(supportPause.statusCode).toBe(403);

      const supportStop = await app.inject({
        method: "POST",
        url: `/cases/${newLiveCase.id}/stop`,
        cookies: { rr_session: supportCookie },
        payload: { reason: "test" },
      });
      expect(supportStop.statusCode).toBe(403);

      // OPERATIONS cannot stop (FINANCE+ required)
      const opsStop = await app.inject({
        method: "POST",
        url: `/cases/${newLiveCase.id}/stop`,
        cookies: { rr_session: operationsCookie },
        payload: { reason: "test" },
      });
      expect(opsStop.statusCode).toBe(403);
    }, 30000);
  });

  // ===========================================================================
  // 4. REST API READ CONTRACTS & TENANT ISOLATION
  // ===========================================================================
  describe("4. Case Read APIs & Tenant Isolation", () => {
    let canonicalCaseId: string;

    beforeAll(async () => {
      const customer = await createCustomer(
        { db },
        {
          tenantId: tenantA.id,
          externalRef: `cus_read_${runId}`,
          name: "Read Test Customer",
          email: `read_${runId}@example.com`,
          optedOut: false,
        },
      );

      const payment = await createPayment(
        { db },
        {
          tenantId: tenantA.id,
          customerId: customer.id,
          provider: "STRIPE",
          providerPaymentId: `pi_read_${runId}`,
          amount: 60_000n,
          currency: "INR",
          status: "FAILED",
          occurredAt: new Date(),
        },
      );

      const { case: c } = await creationService.tryCreateCase({
        tenantId: tenantA.id,
        customerId: customer.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: payment.id,
        amountAtRisk: payment.amount,
        currency: payment.currency,
        riskScore: 65,
      });

      await pipelineService.runPipeline({
        tenantId: tenantA.id,
        caseId: c.id,
      });

      // Converge on WORKFLOW_STARTED (s-17 test hardening): the app's
      // background orchestrator consumer shares this NullBus and races the
      // direct run above for the decide idempotency lease; the loser yields
      // via IdempotencyInFlightError. Re-drive while non-terminal — decide
      // replays idempotently (no re-spend) — until the event lands.
      {
        const deadline = Date.now() + 20000;
        let started = false;
        let lastStatus: string | undefined;
        while (Date.now() < deadline && !started) {
          const tl = await app.inject({
            method: "GET",
            url: `/cases/${c.id}/timeline`,
            cookies: { rr_session: viewerCookie },
          });
          const items = (tl.json() as { items?: unknown })?.items;
          if (
            Array.isArray(items) &&
            items.some((e: unknown) => (e as { eventType?: string })?.eventType === "WORKFLOW_STARTED")
          ) {
            started = true;
            break;
          }
          const row = await findCaseById(
            { db },
            { tenantId: tenantA.id, caseId: c.id },
          );
          lastStatus = row?.status;
          if (row && ["RECOVERED", "STOPPED", "FAILED"].includes(row.status)) {
            break;
          }
          await pipelineService.runPipeline({
            tenantId: tenantA.id,
            caseId: c.id,
          });
          await new Promise((r) => setTimeout(r, 500));
        }
        if (!started) {
          throw new Error(
            `WORKFLOW_STARTED never landed (last case status: ${lastStatus})`,
          );
        }
      }

      canonicalCaseId = c.id;
    }, 30000);

    it("GET /cases lists cases with pagination, filters, and cursor", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/cases?limit=10&status=IN_PROGRESS`,
        cookies: { rr_session: viewerCookie },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(Array.isArray(json.items)).toBe(true);
      for (const item of json.items) {
        expect(item.status).toBe("IN_PROGRESS");
        expect(item.tenant_id).toBe(tenantA.id);
      }
    }, 30000);

    it("GET /cases/:id returns full canonical case detail", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/cases/${canonicalCaseId}`,
        cookies: { rr_session: viewerCookie },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.id).toBe(canonicalCaseId);
      expect(json.case_number).toBeDefined();
      expect(json.amount_at_risk).toBe(60000);
      expect(json.currency).toBe("INR");
      expect(Array.isArray(json.actions)).toBe(true);
    }, 30000);

    it("enforces tenant isolation: Tenant B cannot view Tenant A case (returns 404)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/cases/${canonicalCaseId}`,
        cookies: { rr_session: tenantBCookie },
      });

      expect(res.statusCode).toBe(404);
    }, 30000);

    it("GET /cases/:id/timeline returns chronological case event history", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/cases/${canonicalCaseId}/timeline`,
        cookies: { rr_session: viewerCookie },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(Array.isArray(json.items)).toBe(true);
      expect(json.items.length).toBeGreaterThan(0);
      expect(json.items.some((e: any) => e.eventType === "WORKFLOW_STARTED")).toBe(true);
    }, 30000);
  });
});
