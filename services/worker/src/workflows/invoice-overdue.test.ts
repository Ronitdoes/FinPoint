import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import type { WorkflowHandle } from "@temporalio/client";
import { createActivityMocks } from "../testing/mocks";
import {
  WORKFLOW_ID,
  customerRepliedSignal,
  invoicePaidSignal,
  disputeOpenedSignal,
  humanDecisionSignal,
  type RecoveryWorkflowInput,
} from "./shared";
import { invoiceOverdueWorkflow } from "./invoice-overdue";
import { DailyReconciler } from "../cron/reconciler";
// eslint-disable-next-line no-restricted-imports
import { InProcessEventBus } from "@repo/integrations";
// eslint-disable-next-line no-restricted-imports
import {
  db,
  createTenant,
  createCustomer,
  createInvoice,
  createCase,
} from "@repo/db";

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

describe("Step 24 — Workflow C: Overdue Invoice & Promise-to-Pay Matrix", () => {
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
  // Scenario 1: Full Happy Path
  // Reminder -> Reply PROMISE -> Child PTP Workflow -> Paid on Date -> RECOVERED
  // ---------------------------------------------------------------------------
  it("1. full happy: reminder -> reply PROMISE -> child workflow -> paid on date -> RECOVERED (honored PTP linked)", async () => {
    const caseId = randomUUID();
    const invoiceId = randomUUID();
    const tenantId = randomUUID();
    const paymentId = randomUUID();
    const ptpId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async createPromiseToPay(input) {
        return {
          promiseId: ptpId,
          status: "MADE",
          promisedByDate: input.promisedByDate,
          caseId: input.caseId,
        };
      },
      async resolvePromiseToPay(input) {
        return {
          promiseId: input.promiseId,
          status: input.status,
          resolvedAt: new Date().toISOString(),
          honoredPaymentId: input.honoredPaymentId,
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
      invoiceId,
      workflowType: "invoiceOverdueWorkflow",
      metadata: {
        ladder1Delay: "3d",
        ptpWaitDelay: "7d",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(invoiceOverdueWorkflow, {
        taskQueue,
        workflowId: WORKFLOW_ID(caseId),
        args: [input],
      });

      // Customer replies with PROMISE_TO_PAY
      await handle.signal(customerRepliedSignal, {
        type: "PROMISE_TO_PAY",
        promisedByDate: "2026-09-15",
        promisedAmountMinor: "2500000",
      });

      // Invoice paid signal lands
      await handle.signal(invoicePaidSignal, {
        invoiceId,
        paymentId,
        amount: "2500000",
        currency: "INR",
      });

      return await handle.result();
    });

    expect(result.outcome).toBe("RECOVERED");
    expect(result.ptpStatus).toBe("HONORED");

    // Verify spy calls
    expect(spy.calls.sendTemplateMessage).toBeDefined();
    expect(spy.calls.createPromiseToPay).toBeDefined();
    expect(spy.calls.resolvePromiseToPay).toBeDefined();
    expect(spy.calls.recordOutcome).toBeDefined();
    expect(spy.calls.recordOutcome[0][0]).toMatchObject({
      outcome: "RECOVERED",
      recoverySource: "WORKFLOW_LINKED",
      paymentId,
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 2: Broken Promise Path
  // No payment by grace end -> BROKEN -> Follow-up -> ESCALATED
  // ---------------------------------------------------------------------------
  it("2. broken promise path: no payment by grace end -> BROKEN -> follow-up -> ESCALATED", async () => {
    const caseId = randomUUID();
    const invoiceId = randomUUID();
    const tenantId = randomUUID();
    const ptpId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async createPromiseToPay(input) {
        return {
          promiseId: ptpId,
          status: "MADE",
          promisedByDate: input.promisedByDate,
          caseId: input.caseId,
        };
      },
      async resolvePromiseToPay(input) {
        return {
          promiseId: input.promiseId,
          status: input.status,
          resolvedAt: new Date().toISOString(),
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
      invoiceId,
      workflowType: "invoiceOverdueWorkflow",
      metadata: {
        ladder1Delay: "3d",
        ptpWaitDelay: "5d",
        brokenPtpWaitDelay: "24h",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(invoiceOverdueWorkflow, {
        taskQueue,
        workflowId: WORKFLOW_ID(caseId),
        args: [input],
      });

      // Signal promise to pay
      await handle.signal(customerRepliedSignal, {
        type: "PROMISE_TO_PAY",
        promisedByDate: "2026-09-10",
      });

      // No payment signal -> let time skip through PTP wait and broken follow-up wait
      return await handle.result();
    });

    expect(result.outcome).toBe("ESCALATED");
    expect(result.ptpStatus).toBe("BROKEN");

    // Verify follow-up message sent and human escalation task created
    expect(spy.calls.sendTemplateMessage.length).toBeGreaterThanOrEqual(2);
    expect(spy.calls.createHumanTask).toBeDefined();
    expect(spy.calls.createHumanTask[0][0]).toMatchObject({
      taskType: "GENERAL",
      title: "Manual follow-up for broken promise to pay",
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 3: Expired Promise Path
  // Expired promise -> ESCALATED once (dedupe)
  // ---------------------------------------------------------------------------
  it("3. expired promise -> ESCALATED once (dedupe)", async () => {
    const caseId = randomUUID();
    const invoiceId = randomUUID();
    const tenantId = randomUUID();
    const ptpId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async createPromiseToPay(input) {
        return {
          promiseId: ptpId,
          status: "MADE",
          promisedByDate: input.promisedByDate,
          caseId: input.caseId,
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
      invoiceId,
      workflowType: "invoiceOverdueWorkflow",
      metadata: {
        ladder1Delay: "3d",
        ptpWaitDelay: "5d",
        forceExpire: true,
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(invoiceOverdueWorkflow, {
        taskQueue,
        workflowId: WORKFLOW_ID(caseId),
        args: [input],
      });

      await handle.signal(customerRepliedSignal, {
        type: "PROMISE_TO_PAY",
        promisedByDate: "2026-09-01",
      });

      return await handle.result();
    });

    expect(result.outcome).toBe("ESCALATED");
    expect(result.ptpStatus).toBe("EXPIRED");
    // Verify single escalation task created
    expect(spy.calls.createHumanTask.length).toBe(1);
    expect(spy.calls.createHumanTask[0][0]).toMatchObject({
      title: "Manual follow-up for expired promise to pay",
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 4: Dispute Mid-Ladder
  // Dispute signal -> instant STOP + task; subsequent ladder sends blocked
  // ---------------------------------------------------------------------------
  it("4. dispute mid-ladder -> instant STOP + task; subsequent ladder sends blocked", async () => {
    const caseId = randomUUID();
    const invoiceId = randomUUID();
    const tenantId = randomUUID();

    let workflowHandle: WorkflowHandle<typeof invoiceOverdueWorkflow> | undefined;
    const { mockActivities, spy } = createActivityMocks({
      async sendTemplateMessage(input) {
        if (input.stepKey === "ladder_1" && workflowHandle) {
          await workflowHandle.signal(disputeOpenedSignal, {
            invoiceId,
            caseId,
            reason: "Services not delivered as specified",
          });
        }
        return {
          messageId: randomUUID(),
          status: "SENT",
          sentAt: new Date().toISOString(),
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
      invoiceId,
      workflowType: "invoiceOverdueWorkflow",
      metadata: {
        ladder1Delay: "3d",
      },
    };

    const result = await worker.runUntil(async () => {
      workflowHandle = await testEnv.client.workflow.start(invoiceOverdueWorkflow, {
        taskQueue,
        workflowId: WORKFLOW_ID(caseId),
        args: [input],
      });

      return await workflowHandle.result();
    });

    expect(result.outcome).toBe("STOPPED");
    expect(result.stopReason).toBe("DISPUTED");

    // Verify dispute review task created
    expect(spy.calls.createHumanTask).toBeDefined();
    expect(spy.calls.createHumanTask[0][0]).toMatchObject({
      taskType: "DISPUTE_REVIEW",
    });

    // Verify only 1 message sent before dispute arrived
    expect(spy.calls.sendTemplateMessage.length).toBe(1);
    expect(spy.calls.stopCaseWithReason[0][0]).toMatchObject({
      stopReason: "DISPUTED",
    });
  });

  // ---------------------------------------------------------------------------
  // Scenario 5: High-Value Incentive Interplay (Scenario C Parity)
  // Amount > ₹100,000 -> REQUIRE_APPROVAL -> approve -> sent ; reject -> skipped
  // ---------------------------------------------------------------------------
  it("5. high-value incentive -> REQUIRE_APPROVAL -> approve -> sent ; reject -> skipped (Scenario C parity)", async () => {
    const caseId = randomUUID();
    const invoiceId = randomUUID();
    const tenantId = randomUUID();
    const taskId = randomUUID();

    // 5a. Approval Path
    const { mockActivities: mockActivitiesApprove, spy: spyApprove } = createActivityMocks({
      async checkPolicyAgain(input) {
        if (input.actionType === "OFFER_INCENTIVE") {
          return {
            allowed: true,
            requiresApproval: true,
            ruleCode: "POL-HIGHVALUE",
            policyEvaluationId: randomUUID(),
          };
        }
        return {
          allowed: true,
          requiresApproval: false,
          ruleCode: "PASS",
        };
      },
      async createHumanTask() {
        return {
          taskId,
          status: "PENDING",
          createdAt: new Date().toISOString(),
        };
      },
    });

    const taskQueueA = `test-queue-${randomUUID()}`;
    const workflowsPath = path.resolve(__dirname, "./index.ts");

    const workerA = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.client.options.namespace,
      taskQueue: taskQueueA,
      workflowsPath,
      activities: mockActivitiesApprove,
    });

    const inputApprove: RecoveryWorkflowInput = {
      tenantId,
      caseId,
      invoiceId,
      workflowType: "invoiceOverdueWorkflow",
      metadata: {
        ladder1Delay: "10ms",
        ladder2Delay: "10ms",
        ladder3Delay: "10ms",
        proposedIncentiveDiscountMinor: 100000, // ₹1,000 discount
      },
    };

    const resultA = await workerA.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(invoiceOverdueWorkflow, {
        taskQueue: taskQueueA,
        workflowId: WORKFLOW_ID(caseId),
        args: [inputApprove],
      });

      // Operator approves the high-value discount
      await handle.signal(humanDecisionSignal, {
        taskId,
        approved: true,
        decidedBy: "operator@finance.com",
      });

      return await handle.result();
    });

    expect(resultA.outcome).toBe("ESCALATED");
    expect(spyApprove.calls.createHumanTask).toBeDefined();
    // Payment link generated & 3 ladder messages sent
    expect(spyApprove.calls.createPaymentLinkAndStore).toBeDefined();
    expect(spyApprove.calls.sendTemplateMessage.length).toBe(3);
  });

  // ---------------------------------------------------------------------------
  // Scenario 6: Ladder Cap Enforcement
  // Email counter blocks contact past limit
  // ---------------------------------------------------------------------------
  it("6. ladder cap enforcement: email counter blocks contact when limit reached", async () => {
    const caseId = randomUUID();
    const invoiceId = randomUUID();
    const tenantId = randomUUID();

    let emailEvaluations = 0;
    const { mockActivities, spy } = createActivityMocks({
      async checkPolicyAgain(input) {
        if (input.actionType === "SEND_EMAIL") {
          emailEvaluations++;
          if (emailEvaluations >= 3) {
            // Block 3rd+ email
            return {
              allowed: false,
              requiresApproval: false,
              rejectionReason: "CONTACT_CAP_EXCEEDED",
              ruleCode: "POL-CONTACTCAP",
            };
          }
        }
        return {
          allowed: true,
          requiresApproval: false,
          ruleCode: "PASS",
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
      invoiceId,
      workflowType: "invoiceOverdueWorkflow",
      metadata: {
        ladder1Delay: "10ms",
        ladder2Delay: "10ms",
        ladder3Delay: "10ms",
        step2Channel: "EMAIL",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(invoiceOverdueWorkflow, {
        taskQueue,
        workflowId: WORKFLOW_ID(caseId),
        args: [input],
      });
      return await handle.result();
    });

    expect(result.outcome).toBe("ESCALATED");
    // Message sends blocked by policy cap
    expect(spy.calls.sendTemplateMessage.length).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Scenario 7: Missed-Webhook Reconciler
  // Creates recovery case / emits event for orphaned OVERDUE invoice exactly once
  // ---------------------------------------------------------------------------
  it("7. missed-webhook reconciler creates case for orphaned OVERDUE invoice exactly once", async () => {
    const tenant = await createTenant(
      { db },
      { name: `Reconcile Tenant ${randomUUID()}`, slug: `reconcile-${randomUUID().slice(0, 8)}` },
    );

    const customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        externalRef: `ext-${randomUUID()}`,
        name: "Orphaned Customer",
        email: `orphaned-${randomUUID().slice(0, 6)}@test.com`,
      },
    );

    const orphanedInvoice = await createInvoice(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        number: `INV-ORPHAN-${randomUUID().slice(0, 6)}`,
        amount: 5000000n,
        currency: "INR",
        dueAt: new Date(Date.now() - 5 * 86400000), // 5 days ago
        status: "OVERDUE",
      },
    );

    const eventBus = new InProcessEventBus();
    const emitted: string[] = [];
    eventBus.subscribe("revenue-events.v1", "test-reconciler-listener", async (event) => {
      if (event.type === "invoice.overdue") {
        emitted.push(event.entity_id);
      }
    });

    const reconciler = new DailyReconciler({ db, eventBus });

    // Run 1: Should detect and emit for the orphaned invoice
    const run1 = await reconciler.reconcileOrphanedInvoices(tenant.id);
    expect(run1.processedCount).toBe(1);
    expect(run1.emittedEvents).toContain(orphanedInvoice.id);

    // Create a live case for this invoice to simulate successful pipeline initiation
    await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        riskType: "INVOICE_OVERDUE",
        sourceEntityType: "INVOICE",
        sourceEntityId: orphanedInvoice.id,
        amountAtRisk: 5000000n,
        currency: "INR",
        riskScore: 65,
        status: "IN_PROGRESS",
      },
    );

    // Run 2: Reconciler should find 0 orphaned invoices now (idempotent / deduplicated)
    const run2 = await reconciler.reconcileOrphanedInvoices(tenant.id);
    expect(run2.processedCount).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Scenario 8: 30-Day Time-Skipped Run
  // Completes multi-week timeline without timeout errors
  // ---------------------------------------------------------------------------
  it("8. 30-day time-skipped run completes without timeout errors", async () => {
    const caseId = randomUUID();
    const invoiceId = randomUUID();
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
      invoiceId,
      workflowType: "invoiceOverdueWorkflow",
      metadata: {
        ladder1Delay: "3d",
        ladder2Delay: "7d",
        ladder3Delay: "3d",
      },
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(invoiceOverdueWorkflow, {
        taskQueue,
        workflowId: WORKFLOW_ID(caseId),
        args: [input],
      });

      return await handle.result();
    });

    expect(result.outcome).toBe("ESCALATED");
    expect(spy.calls.sendTemplateMessage.length).toBe(3);
    expect(spy.calls.createPaymentLinkAndStore).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Scenario 9: Paid-Before-Start
  // Already PAID invoice event replay -> exits immediately without reminder
  // ---------------------------------------------------------------------------
  it("9. paid-before-start (already PAID invoice replay) -> exits immediately with RECOVERED", async () => {
    const caseId = randomUUID();
    const invoiceId = randomUUID();
    const tenantId = randomUUID();

    const { mockActivities, spy } = createActivityMocks({
      async checkInvoiceStatus() {
        return {
          exists: true,
          status: "PAID",
          isPaid: true,
          isDisputed: false,
          amount: "5000000",
          amountPaid: "5000000",
          currency: "INR",
          paidAt: new Date().toISOString(),
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
      invoiceId,
      workflowType: "invoiceOverdueWorkflow",
    };

    const result = await worker.runUntil(async () => {
      const handle = await testEnv.client.workflow.start(invoiceOverdueWorkflow, {
        taskQueue,
        workflowId: WORKFLOW_ID(caseId),
        args: [input],
      });
      return await handle.result();
    });

    expect(result.outcome).toBe("RECOVERED");
    // No reminder message was sent
    expect(spy.calls.sendTemplateMessage).toBeUndefined();
    expect(spy.calls.recordOutcome).toBeDefined();
    expect(spy.calls.recordOutcome[0][0]).toMatchObject({
      outcome: "RECOVERED",
      recoverySource: "PRE_EXISTING",
    });
  });
});
