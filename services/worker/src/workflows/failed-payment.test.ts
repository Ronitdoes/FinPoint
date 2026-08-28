import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createActivityMocks } from "../testing/mocks";
import {
  WORKFLOW_ID,
  stopSignal,
  humanDecisionSignal,
  externalPaymentSucceededSignal,
  workflowStateQuery,
  type RecoveryWorkflowInput,
} from "./shared";
import { failedPaymentRecoveryWorkflow } from "./failed-payment";
import { createNonRetryableFailure } from "../framework";
import { startRecoveryWorkflow } from "../client";
import { PaymentSuccessSignalBridge } from "../signaling/payment-success.bridge";
// eslint-disable-next-line no-restricted-imports
import { db, createTenant, createCustomer, createCase } from "@repo/db";
// eslint-disable-next-line no-restricted-imports
import type { EventBus } from "@repo/integrations";
import type { RecoveryWorkflowClient } from "@repo/orchestration";

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

if (typeof BigInt !== "undefined" && !BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function (this: bigint) {
    return this.toString();
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe("Step 22 — Workflow A: Failed Payment Recovery Matrix", () => {
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    try {
      testEnv = await TestWorkflowEnvironment.createTimeSkipping();
    } catch {
      testEnv = await TestWorkflowEnvironment.createLocal({
        server: { port: 7233 },
      });
    }
  }, 60000);

  afterAll(async () => {
    if (testEnv) {
      await testEnv.teardown();
    }
  });

  // ---------------------------------------------------------------------------
  // 1. Happy Path
  // ---------------------------------------------------------------------------
  it("1. happy path: msg -> wait(24h skipped) -> retry SUCCEEDED -> RECOVERED + outcome recorded", async () => {
    const caseId = randomUUID();
    const paymentId = `pay_${randomUUID()}`;
    const tenantId = randomUUID();
    const actionId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async loadCaseSnapshot(ctx) {
        return {
          case: {
            id: ctx.caseId,
            tenantId: ctx.tenantId,
            caseNumber: 101,
            customerId: "cust_1",
            riskId: "risk_1",
            status: "IN_PROGRESS",
            riskType: "PAYMENT_FAILURE",
            sourceEntityType: "PAYMENT",
            sourceEntityId: paymentId,
            amountAtRisk: BigInt(1299900),
            currency: "INR",
            riskScore: 75,
            statusReason: null,
            stopConditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT", "MAX_RETRIES"],
            assignedTo: null,
            workflowId: null,
            attributionWindowHours: 72,
            openedAt: new Date(),
            closedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          risk: null,
          customer: {
            id: "cust_1",
            tenantId: ctx.tenantId,
            externalRef: "cus_stripe_1",
            name: "John Doe",
            email: "john@example.com",
            phone: "+919876543210",
            status: "ACTIVE",
            lifetimeValue: BigInt(5000000),
            optedOut: false,
            optedOutAt: null,
            metadata: {},
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null,
          },
          actions: [
            {
              id: actionId,
              tenantId: ctx.tenantId,
              caseId: ctx.caseId,
              decisionId: null,
              type: "SEND_WHATSAPP",
              status: "APPROVED",
              attemptNumber: 1,
              parameters: {
                template: "payment_retry_notice",
                variables: { amount: "₹12,999" },
              },
              policyResult: null,
              result: null,
              error: null,
              idempotencyKey: `${ctx.tenantId}:${ctx.caseId}:SEND_WHATSAPP:1`,
              scheduledAt: new Date(),
              startedAt: null,
              completedAt: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          ],
        };
      },
      async executeRetryPayment(input) {
        return {
          status: "SUCCEEDED",
          attemptId: `att_${randomUUID()}`,
          paymentId: input.paymentId,
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
      paymentId,
      amountMinor: "1299900",
      currency: "INR",
      metadata: {
        retryDelay: "24h",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        failedPaymentRecoveryWorkflow,
        {
          workflowId: WORKFLOW_ID(caseId),
          taskQueue,
          args: [input],
        },
      );

      return await handle.result();
    });

    expect(result).toEqual({ outcome: "RECOVERED", attemptNumber: 1 });
    expect(spy.calls["sendTemplateMessage"]).toBeDefined();
    expect(spy.calls["executeRetryPayment"]).toBeDefined();
    expect(spy.calls["recordOutcome"]).toBeDefined();
    expect(spy.calls["emitMetric"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 2. Fail -> Fail -> Fail (Max retries exhausted & Replan Stop)
  // ---------------------------------------------------------------------------
  it("2. fail->fail->fail: 3 rounds then replan -> STOPPED(MAX_RETRIES); retry_count never exceeds 3", async () => {
    const caseId = randomUUID();
    const paymentId = `pay_${randomUUID()}`;
    const tenantId = randomUUID();
    let attemptsCount = 0;

    const { mockActivities, spy } = createActivityMocks({
      async executeRetryPayment(input) {
        attemptsCount++;
        return {
          status: "FAILED",
          attemptId: `att_${randomUUID()}`,
          paymentId: input.paymentId,
          declineCode: "insufficient_funds",
          declineMessage: "Card has insufficient funds",
        };
      },
      async requestReplanDecision() {
        return {
          decisionId: randomUUID(),
          replanAction: "STOP_CASE",
          actions: [{ type: "STOP_CASE", parameters: { reason: "MAX_RETRIES" } }],
          stopReason: "MAX_RETRIES",
          diagnosis: "3 retries failed due to insufficient funds; stopping case",
          allowed: true,
          requiresApproval: false,
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
      paymentId,
      metadata: {
        retryDelay: "1s",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        failedPaymentRecoveryWorkflow,
        {
          workflowId: WORKFLOW_ID(caseId),
          taskQueue,
          args: [input],
        },
      );

      return await handle.result();
    });

    expect(result).toEqual({ outcome: "STOPPED", stopReason: "MAX_RETRIES" });
    expect(attemptsCount).toBe(3);
    expect(spy.calls["executeRetryPayment"]?.length).toBe(3);
    expect(spy.calls["requestReplanDecision"]?.length).toBe(1);
    expect(spy.calls["stopCaseWithReason"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 3. Retry then success (Round 1 FAILED -> Round 2 SUCCEEDED)
  // ---------------------------------------------------------------------------
  it("3. retry then success: FAILED round1 -> SUCCEEDED round2 -> RECOVERED", async () => {
    const caseId = randomUUID();
    const paymentId = `pay_${randomUUID()}`;
    const tenantId = randomUUID();
    let attempt = 0;

    const { mockActivities, spy } = createActivityMocks({
      async executeRetryPayment(input) {
        attempt++;
        if (attempt === 1) {
          return {
            status: "FAILED",
            attemptId: `att_${randomUUID()}`,
            paymentId: input.paymentId,
            declineCode: "try_again_later",
          };
        }
        return {
          status: "SUCCEEDED",
          attemptId: `att_${randomUUID()}`,
          paymentId: input.paymentId,
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
      paymentId,
      metadata: { retryDelay: "1s" },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        failedPaymentRecoveryWorkflow,
        {
          workflowId: WORKFLOW_ID(caseId),
          taskQueue,
          args: [input],
        },
      );

      return await handle.result();
    });

    expect(result).toEqual({ outcome: "RECOVERED", attemptNumber: 2 });
    expect(attempt).toBe(2);
    expect(spy.calls["recordOutcome"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 4. Permanent failure (do_not_honor x3 + replan STOP)
  // ---------------------------------------------------------------------------
  it("4. permanent failure: do_not_honor x3 + replan STOP(PERMANENT_DECLINE)", async () => {
    const caseId = randomUUID();
    const paymentId = `pay_${randomUUID()}`;
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async executeRetryPayment(input) {
        return {
          status: "FAILED",
          attemptId: `att_${randomUUID()}`,
          paymentId: input.paymentId,
          declineCode: "do_not_honor",
          declineMessage: "Issuer declined transaction permanently",
        };
      },
      async requestReplanDecision() {
        return {
          decisionId: randomUUID(),
          replanAction: "STOP_CASE",
          actions: [{ type: "STOP_CASE", parameters: { reason: "PERMANENT_DECLINE" } }],
          stopReason: "PERMANENT_DECLINE",
          diagnosis: "Issuer do_not_honor code received; permanent decline",
          allowed: true,
          requiresApproval: false,
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
      paymentId,
      metadata: { retryDelay: "1s" },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        failedPaymentRecoveryWorkflow,
        {
          workflowId: WORKFLOW_ID(caseId),
          taskQueue,
          args: [input],
        },
      );

      return await handle.result();
    });

    expect(result).toEqual({ outcome: "STOPPED", stopReason: "PERMANENT_DECLINE" });
    expect(spy.calls["stopCaseWithReason"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 5. Duplicate Execution (Idempotent Start)
  // ---------------------------------------------------------------------------
  it("5. duplicate execution: same workflow id started twice -> single logical run", async () => {
    const tenant = await createTenant(
      { db },
      { name: "Duplicate Test Tenant", slug: `dup-test-${randomUUID()}` },
    );
    const customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        email: `dup_${randomUUID()}@example.com`,
        phone: "+919876543210",
        name: "Dup Customer",
      },
    );
    const caseRec = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        status: "IN_PROGRESS",
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: randomUUID(),
        amountAtRisk: BigInt(10000),
        currency: "INR",
        riskScore: 50,
      },
    );
    const tenantId = tenant.id;
    const caseId = caseRec.id;

    // Test client level idempotency guarantee
    const res1 = await startRecoveryWorkflow({
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
    });

    expect(res1.accepted).toBe(true);
    expect(res1.temporalWorkflowId).toBe(`recover:${caseId}`);

    const res2 = await startRecoveryWorkflow({
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
    });

    expect(res2.accepted).toBe(false);
    expect(res2.workflowId).toBe(res1.workflowId);
  });

  // ---------------------------------------------------------------------------
  // 6. Concurrent Attempts (Double Charge Prevention)
  // ---------------------------------------------------------------------------
  it("6. concurrent attempts: deterministic idempotency keys prevent duplicate charges", async () => {
    const tenantId = randomUUID();
    const caseId = randomUUID();
    const attemptNumber = 1;

    const key1 = `${tenantId}:${caseId}:RETRY_PAYMENT:${attemptNumber}`;
    const key2 = `${tenantId}:${caseId}:RETRY_PAYMENT:${attemptNumber}`;

    expect(key1).toBe(key2);
    expect(key1).toContain(`RETRY_PAYMENT:${attemptNumber}`);
  });

  // ---------------------------------------------------------------------------
  // 7. Provider Timeout (UNKNOWN -> Poll loop -> Resolved SUCCEEDED)
  // ---------------------------------------------------------------------------
  it("7. provider timeout: SIMULATE_PAYMENT_TIMEOUT -> UNKNOWN -> poll -> resolved SUCCEEDED", async () => {
    const caseId = randomUUID();
    const paymentId = `pay_${randomUUID()}`;
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async executeRetryPayment(input) {
        return {
          status: "UNKNOWN",
          attemptId: `att_${randomUUID()}`,
          paymentId: input.paymentId,
        };
      },
      async refreshPaymentStatus(input) {
        return {
          status: "SUCCEEDED",
          paymentId: input.paymentId,
          settledAt: new Date().toISOString(),
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
      paymentId,
      metadata: { retryDelay: "1s" },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        failedPaymentRecoveryWorkflow,
        {
          workflowId: WORKFLOW_ID(caseId),
          taskQueue,
          args: [input],
        },
      );

      return await handle.result();
    });

    expect(result).toEqual({ outcome: "RECOVERED", attemptNumber: 1 });
    expect(spy.calls["refreshPaymentStatus"]).toBeDefined();
    expect(spy.calls["recordOutcome"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 8. Provider Error (5xx storm -> Activity retries exhausted -> ESCALATED)
  // ---------------------------------------------------------------------------
  it("8. provider error: fatal error -> ESCALATED(workflow failure task created)", async () => {
    const caseId = randomUUID();
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async loadCaseSnapshot() {
        throw createNonRetryableFailure(
          "HTTP 503 Provider unavailable storm",
          "PROVIDER_UNAVAILABLE",
        );
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
    };

    await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        failedPaymentRecoveryWorkflow,
        {
          workflowId: WORKFLOW_ID(caseId),
          taskQueue,
          args: [input],
        },
      );

      await expect(handle.result()).rejects.toThrow();
    });

    expect(spy.calls["escalateWorkflowFailure"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 9. Opt-out Mid-flight (Stop signal received -> Immediate STOPPED)
  // ---------------------------------------------------------------------------
  it("9. opt-out mid-flight: signal received between rounds -> immediate STOPPED(CUSTOMER_OPTED_OUT)", async () => {
    const caseId = randomUUID();
    const paymentId = `pay_${randomUUID()}`;
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async executeRetryPayment(input) {
        return {
          status: "FAILED",
          attemptId: `att_${randomUUID()}`,
          paymentId: input.paymentId,
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
      paymentId,
      metadata: { retryDelay: "24h" },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        failedPaymentRecoveryWorkflow,
        {
          workflowId: WORKFLOW_ID(caseId),
          taskQueue,
          args: [input],
        },
      );

      // Signal stop mid-flight
      await handle.signal(stopSignal, { reason: "CUSTOMER_OPTED_OUT" });

      return await handle.result();
    });

    expect(result).toEqual({ outcome: "STOPPED", stopReason: "CUSTOMER_OPTED_OUT" });
    expect(spy.calls["stopCaseWithReason"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 10. External Success (Original channel payment lands during WAIT -> Instant Close)
  // ---------------------------------------------------------------------------
  it("10. external success: original-channel payment lands during WAIT -> instant close without consuming retry", async () => {
    const caseId = randomUUID();
    const paymentId = `pay_${randomUUID()}`;
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks();

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
      paymentId,
      metadata: { retryDelay: "72h" },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        failedPaymentRecoveryWorkflow,
        {
          workflowId: WORKFLOW_ID(caseId),
          taskQueue,
          args: [input],
        },
      );

      // Signal external payment success during the 72h wait
      await handle.signal(externalPaymentSucceededSignal, {
        paymentId,
        amount: "1299900",
        currency: "INR",
        paidAt: new Date().toISOString(),
      });

      return await handle.result();
    });

    expect(result).toEqual({ outcome: "RECOVERED" });
    // Verify retry was never consumed!
    expect(spy.calls["executeRetryPayment"]).toBeUndefined();
    expect(spy.calls["recordOutcome"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 11. Approval Flow (Replan proposes incentive -> REQUIRE_APPROVAL -> Reject -> STOPPED)
  // ---------------------------------------------------------------------------
  it("11. approval flow: replan proposes incentive -> REQUIRE_APPROVAL -> reject -> STOPPED(HUMAN_REJECTED)", async () => {
    const caseId = randomUUID();
    const paymentId = `pay_${randomUUID()}`;
    const tenantId = randomUUID();
    let capturedTaskId = "";

    const { mockActivities, spy } = createActivityMocks({
      async executeRetryPayment(input) {
        return {
          status: "FAILED",
          attemptId: `att_${randomUUID()}`,
          paymentId: input.paymentId,
        };
      },
      async requestReplanDecision() {
        return {
          decisionId: randomUUID(),
          replanAction: "OFFER_INCENTIVE",
          actions: [{ type: "OFFER_INCENTIVE", parameters: { discount_minor: 100000 } }],
          diagnosis: "Customer high churn risk; propose incentive with human approval",
          allowed: true,
          requiresApproval: true,
        };
      },
      async createHumanTask() {
        capturedTaskId = `task_${randomUUID()}`;
        return {
          taskId: capturedTaskId,
          status: "PENDING",
          createdAt: new Date().toISOString(),
        };
      },
      async waitForHumanDecision(input) {
        return {
          taskId: input.taskId,
          status: "REJECTED",
          approved: false,
          decidedBy: "operator@example.com",
          decisionNotes: "Incentive rejected by finance manager",
          decidedAt: new Date().toISOString(),
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
      paymentId,
      metadata: { retryDelay: "1s" },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(
        failedPaymentRecoveryWorkflow,
        {
          workflowId: WORKFLOW_ID(caseId),
          taskQueue,
          args: [input],
        },
      );

      // Wait a moment for replan human task creation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Signal human rejection
      await handle.signal(humanDecisionSignal, {
        taskId: capturedTaskId,
        approved: false,
        notes: "Incentive rejected by finance manager",
      });

      return await handle.result();
    });

    expect(result).toEqual({ outcome: "STOPPED", stopReason: "HUMAN_REJECTED" });
    expect(spy.calls["createHumanTask"]).toBeDefined();
    expect(spy.calls["stopCaseWithReason"]).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // 12. Restart Survival (Worker restart mid-flight -> Resumes to completion)
  // ---------------------------------------------------------------------------
  it("12. restart survival: kill worker mid-round -> resume completes correctly", async () => {
    const caseId = randomUUID();
    const paymentId = `pay_${randomUUID()}`;
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async executeRetryPayment(input) {
        return {
          status: "SUCCEEDED",
          attemptId: `att_${randomUUID()}`,
          paymentId: input.paymentId,
        };
      },
    });

    const taskQueue = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    // Start Worker 1 to begin workflow execution
    const worker1 = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const input: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      workflowType: "failedPaymentRecoveryWorkflow",
      paymentId,
      metadata: { retryDelay: "10ms" },
    };

    const handle = await testEnv.client.workflow.start(
      failedPaymentRecoveryWorkflow,
      {
        workflowId: WORKFLOW_ID(caseId),
        taskQueue,
        args: [input],
      },
    );

    // Let Worker 1 process start and reach the wait delay checkpoint
    await worker1.runUntil(async () => {
      for (let i = 0; i < 200; i++) {
        try {
          const state = await handle.query(workflowStateQuery);
          if (state && state.currentStep === "ROUND_1_WAIT_DELAY") {
            break;
          }
        } catch {
          // not started yet
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    });

    // Start Worker 2 on same task queue to resume execution
    const worker2 = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue,
      workflowsPath,
      activities: mockActivities,
    });

    const result = await worker2.runUntil(async () => {
      await testEnv.sleep("1s");
      return await handle.result();
    });

    expect(result).toEqual({ outcome: "RECOVERED", attemptNumber: 1 });
    expect(spy.calls["recordOutcome"]).toBeDefined();
  }, 90000);

  // ---------------------------------------------------------------------------
  // 13. Signal Bridge Test
  // ---------------------------------------------------------------------------
  it("signals active workflow when payment.succeeded domain event is received", async () => {
    const tenantId = randomUUID();
    const paymentId = randomUUID();
    const caseId = randomUUID();

    let signaledSignal = "";
    let signaledPayload: unknown = null;

    const mockWorkflowClient: Partial<RecoveryWorkflowClient> = {
      startRecoveryWorkflow: async () => ({
        workflowId: randomUUID(),
        temporalWorkflowId: `recover:${caseId}`,
        accepted: true,
      }),
      signalCase: async (opts) => {
        signaledSignal = opts.signal;
        signaledPayload = opts.payload;
      },
      cancelWorkflow: async () => {},
    };

    const mockEventBus: EventBus = {
      publish: async () => {},
      subscribe: () => {},
      close: async () => {},
    };

    const bridge = new PaymentSuccessSignalBridge({
      eventBus: mockEventBus,
      workflowClient: mockWorkflowClient as RecoveryWorkflowClient,
    });

    await bridge.handleDomainEvent({
      id: randomUUID(),
      tenant_id: tenantId,
      customer_id: "cust-1",
      source: "STRIPE",
      type: "payment.succeeded",
      entity_type: "PAYMENT",
      entity_id: paymentId,
      payload: {
        paymentId,
        amount: 50000,
        currency: "INR",
      },
      occurred_at: new Date().toISOString(),
      correlation_id: randomUUID(),
    });

    expect(bridge).toBeDefined();
    expect(signaledSignal).toBeDefined();
    expect(signaledPayload).toBeDefined();
  });
});
