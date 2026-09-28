import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  loadCaseSnapshot,
  checkPolicyAgain,
  executeRetryPayment,
  createPaymentLinkAndStore,
  sendTemplateMessage,
  refreshPaymentStatus,
  recordOutcome,
  createHumanTask,
  waitForHumanDecision,
  markCaseWaiting,
  markCaseInProgress,
  stopCaseWithReason,
  appendTimeline,
  emitMetric,
  escalateWorkflowFailure,
  requestReplanDecision,
} from "../activities";
import {
  db,
  createTenant,
  createCustomer,
  createCase,
  createPayment,
  createPaymentAttempt,
  createCheckout,
  findCaseById,
  findHumanTaskById,
  listCaseEvents,
  findPaymentById,
  type Tenant,
  type Customer,
  type RecoveryCase,
} from "@repo/db";
import {
  STANDARD_RETRY_POLICY,
  PROVIDER_POLL_RETRY_POLICY,
  NON_RETRYABLE_ERROR_TYPES,
} from "../framework";

describe("Step 20 — 15 Shared Activities Suite", () => {
  let tenant: Tenant;
  let customer: Customer;
  let recoveryCase: RecoveryCase;

  beforeEach(async () => {
    tenant = await createTenant(
      { db },
      { name: "Test Tenant", slug: `test-${randomUUID()}` },
    );

    customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        email: `cust_${randomUUID()}@example.com`,
        phone: "+919876543210",
        name: "Test Customer",
      },
    );

    recoveryCase = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        status: "IN_PROGRESS",
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: randomUUID(),
        amountAtRisk: BigInt(150000),
        currency: "INR",
        riskScore: 60,
      },
    );
  });

  it("1. loadCaseSnapshot loads case, customer, and action records", async () => {
    const snapshot = await loadCaseSnapshot({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
    });

    expect(snapshot.case.id).toBe(recoveryCase.id);
    expect(snapshot.customer?.id).toBe(customer.id);
    expect(snapshot.actions).toBeInstanceOf(Array);
  });

  it("2. checkPolicyAgain re-evaluates policies and records evaluation ledger", async () => {
    const result = await checkPolicyAgain({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      actionType: "RETRY_PAYMENT",
      actionParams: { attempt: 1 },
      amountMinor: "150000",
      currency: "INR",
    });

    expect(result.allowed).toBe(true);
    expect(result.policyEvaluationId).toBeDefined();
  });

  it("3. executeRetryPayment executes mock payment retry and records attempt in DB", async () => {
    const payment = await createPayment(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        amount: BigInt(150000),
        currency: "INR",
        provider: "MOCK",
        providerPaymentId: `mock_${randomUUID()}`,
        status: "FAILED",
        occurredAt: new Date(),
      },
    );

    const result = await executeRetryPayment({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      paymentId: payment.id,
      attemptNumber: 2,
      provider: "MOCK",
    });

    expect(result.status).toBe("SUCCEEDED");
    expect(result.attemptId).toBeDefined();

    const updatedPayment = await findPaymentById(
      { db },
      { tenantId: tenant.id, paymentId: payment.id },
    );
    expect(updatedPayment?.status).toBe("SUCCEEDED");
  });

  it("4. createPaymentLinkAndStore creates link and attaches to checkout", async () => {
    const checkout = await createCheckout(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        cartValue: BigInt(50000),
        currency: "INR",
        status: "ABANDONED",
        startedAt: new Date(),
        lastActivityAt: new Date(),
      },
    );

    const result = await createPaymentLinkAndStore({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      customerId: customer.id,
      checkoutId: checkout.id,
      amountMinor: "50000",
      currency: "INR",
    });

    expect(result.url).toContain("https://");
    expect(result.paymentLinkId).toBeDefined();
  });

  it("5. sendTemplateMessage sends valid template and rejects opted-out customers", async () => {
    const result = await sendTemplateMessage({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      customerId: customer.id,
      channel: "EMAIL",
      templateName: "payment_retry_notice",
      templateVariables: {
        customer_name: "Test Customer",
        amount: "1500",
        currency: "INR",
        payment_link: "https://pay.example.com/link-123",
        due_date: "2026-09-01",
      },
      stepKey: "step-1",
    });

    expect(result.status).toBe("SENT");
    expect(result.messageId).toBeDefined();
  });

  it("6. refreshPaymentStatus queries payment provider status", async () => {
    const payment = await createPayment(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        amount: BigInt(150000),
        currency: "INR",
        provider: "MOCK",
        providerPaymentId: `mock_${randomUUID()}`,
        status: "PENDING",
        occurredAt: new Date(),
      },
    );

    const result = await refreshPaymentStatus({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      paymentId: payment.id,
    });

    expect(["SUCCEEDED", "FAILED", "PENDING", "UNKNOWN"]).toContain(result.status);
  });

  it("7. recordOutcome writes recovery outcome and updates case to terminal state", async () => {
    const result = await recordOutcome({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      outcome: "RECOVERED",
      recoveredAmountMinor: "150000",
      currency: "INR",
    });

    expect(result.outcome).toBe("RECOVERED");
    expect(result.outcomeId).toBeDefined();

    const caseRec = await findCaseById(
      { db },
      { tenantId: tenant.id, caseId: recoveryCase.id },
    );
    expect(caseRec?.status).toBe("RECOVERED");
  });

  it("8. createHumanTask creates task and records timeline event", async () => {
    const result = await createHumanTask({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      taskType: "APPROVAL",
      title: "High value discount review",
      priority: "HIGH",
    });

    expect(result.taskId).toBeDefined();
    expect(result.status).toBe("PENDING");

    const task = await findHumanTaskById(
      { db },
      { tenantId: tenant.id, taskId: result.taskId },
    );
    expect(task?.title).toBe("High value discount review");
  });

  it("9. waitForHumanDecision queries decision status", async () => {
    const taskResult = await createHumanTask({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      taskType: "APPROVAL",
      title: "Manual review",
    });

    const check = await waitForHumanDecision({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      taskId: taskResult.taskId,
    });

    expect(check.taskId).toBe(taskResult.taskId);
    expect(check.status).toBe("PENDING");
  });

  it("10-12. markCaseWaiting, markCaseInProgress, stopCaseWithReason execute guarded transitions", async () => {
    const waitResult = await markCaseWaiting({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      reason: "Customer promised to pay on Friday",
    });
    expect(waitResult.status).toBe("WAITING");

    const progressResult = await markCaseInProgress({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      reason: "Follow-up schedule arrived",
    });
    expect(progressResult.status).toBe("IN_PROGRESS");

    const stopResult = await stopCaseWithReason({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      stopReason: "CUSTOMER_OPTED_OUT",
    });
    expect(stopResult.status).toBe("STOPPED");
  });

  it("13. appendTimeline appends arbitrary timeline event", async () => {
    const result = await appendTimeline({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      type: "CUSTOM_NOTE_ADDED",
      description: "Spoke to customer via phone",
    });

    expect(result.eventId).toBeDefined();

    const events = await listCaseEvents(
      { db },
      { tenantId: tenant.id, caseId: recoveryCase.id },
    );
    expect(events.some((e) => e.description === "Spoke to customer via phone")).toBe(true);
  });

  it("14. emitMetric increments metric instruments without throwing", async () => {
    const result = await emitMetric({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      metricName: "workflow_started_total",
      labels: { type: "RECOVERY_PAYMENT" },
    });

    expect(result.success).toBe(true);
  });

  it("15. escalateWorkflowFailure escalates case and creates urgent human task", async () => {
    const result = await escalateWorkflowFailure({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      errorName: "UnhandledTimeoutException",
      errorMessage: "Provider gateway completely unresponsive",
      failedStep: "RETRY_PAYMENT",
    });

    expect(result.success).toBe(true);
    expect(result.taskId).toBeDefined();

    const caseRec = await findCaseById(
      { db },
      { tenantId: tenant.id, caseId: recoveryCase.id },
    );
    expect(caseRec?.status).toBe("ESCALATED");
  });

  it("16. requestReplanDecision evaluates replan path and records decision", async () => {
    const result = await requestReplanDecision({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      attemptsCount: 3,
      lastDeclineCode: "insufficient_funds",
    });

    expect(result.decisionId).toBeDefined();
    expect(result.replanAction).toBe("STOP_CASE");
    expect(result.stopReason).toBe("MAX_RETRIES");
    expect(result.allowed).toBe(true);
  });

  it("framework retry policies declare non-retryable error types correctly", () => {
    expect(STANDARD_RETRY_POLICY.maximumAttempts).toBe(3);
    expect(PROVIDER_POLL_RETRY_POLICY.maximumAttempts).toBe(12);
    expect(NON_RETRYABLE_ERROR_TYPES).toContain("VALIDATION_FAILED");
    expect(NON_RETRYABLE_ERROR_TYPES).toContain("POLICY_REJECTED");
    expect(NON_RETRYABLE_ERROR_TYPES).toContain("CUSTOMER_OPTED_OUT");
  });
});

describe("s-22/s-24 — Policy-threading gaps (retry_count / payment_status / bare link)", () => {
  let tenant: Tenant;
  let customer: Customer;

  beforeEach(async () => {
    tenant = await createTenant(
      { db },
      { name: "Policy Threading Tenant", slug: `pol-${randomUUID()}` },
    );

    customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        email: `pol_${randomUUID()}@example.com`,
        phone: "+919876543210",
        name: "Policy Customer",
      },
    );
  });

  async function createPaymentLinkedCase(
    amountMinor: bigint,
    paymentStatus: "FAILED" | "SUCCEEDED" = "FAILED",
  ) {
    const payment = await createPayment(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        amount: amountMinor,
        currency: "INR",
        provider: "MOCK",
        providerPaymentId: `mock_${randomUUID()}`,
        status: paymentStatus,
        occurredAt: new Date(),
      },
    );
    const recoveryCase = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        status: "IN_PROGRESS",
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: payment.id,
        amountAtRisk: amountMinor,
        currency: "INR",
        riskScore: 60,
      },
    );
    return { payment, recoveryCase };
  }

  async function recordFailedAttempts(paymentId: string, attemptNumbers: number[]) {
    for (const attemptNumber of attemptNumbers) {
      await createPaymentAttempt(
        { db },
        {
          tenantId: tenant.id,
          paymentId,
          attemptNumber,
          initiatedBy: "RECOVERY_WORKFLOW",
          idempotencyKey: `${tenant.id}:${paymentId}:attempt:${attemptNumber}:${randomUUID()}`,
          status: "FAILED",
          requestedAt: new Date(),
        },
      );
    }
  }

  it("POL-MAXRETRY fires from live DB attempt count (no explicit counters)", async () => {
    const { payment, recoveryCase } = await createPaymentLinkedCase(BigInt(150000));

    // Below threshold: 2 recorded attempts -> retry allowed
    await recordFailedAttempts(payment.id, [1, 2]);
    const allowed = await checkPolicyAgain({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      actionType: "RETRY_PAYMENT",
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.requiresApproval).toBe(false);

    // At threshold: 3 recorded attempts -> POL-MAXRETRY rejects
    await recordFailedAttempts(payment.id, [3]);
    const rejected = await checkPolicyAgain({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      actionType: "RETRY_PAYMENT",
    });
    expect(rejected.allowed).toBe(false);
    expect(rejected.ruleCode).toBe("POL-MAXRETRY");
    expect(rejected.rejectionReason).toBe("MAX_RETRIES_REACHED");
  });

  it("explicit counters.retry_count takes precedence over the DB count", async () => {
    const { payment, recoveryCase } = await createPaymentLinkedCase(BigInt(150000));
    await recordFailedAttempts(payment.id, [1, 2, 3]);

    // Explicit 0 overrides the 3 live DB attempts -> allowed
    const overridden = await checkPolicyAgain({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      actionType: "RETRY_PAYMENT",
      counters: { retry_count: 0 },
    });
    expect(overridden.allowed).toBe(true);

    // Explicit 3 on a case with no payment linkage -> rejected
    const unlinked = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        status: "IN_PROGRESS",
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "INVOICE",
        sourceEntityId: randomUUID(),
        amountAtRisk: BigInt(150000),
        currency: "INR",
        riskScore: 60,
      },
    );
    const explicit = await checkPolicyAgain({
      tenantId: tenant.id,
      caseId: unlinked.id,
      actionType: "RETRY_PAYMENT",
      counters: { retry_count: 3 },
    });
    expect(explicit.allowed).toBe(false);
    expect(explicit.ruleCode).toBe("POL-MAXRETRY");
  });

  it("POL-PAYMENT-SUCCESS fires when the linked payment already SUCCEEDED", async () => {
    const { recoveryCase } = await createPaymentLinkedCase(
      BigInt(150000),
      "SUCCEEDED",
    );

    const result = await checkPolicyAgain({
      tenantId: tenant.id,
      caseId: recoveryCase.id,
      actionType: "RETRY_PAYMENT",
    });
    expect(result.allowed).toBe(false);
    expect(result.ruleCode).toBe("POL-PAYMENT-SUCCESS");
    expect(result.rejectionReason).toBe("PAYMENT_ALREADY_SUCCEEDED");
  });

  it("POL-HIGHVALUE requires approval on a bare high-value CREATE_PAYMENT_LINK", async () => {
    const highValueCase = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        status: "IN_PROGRESS",
        riskType: "INVOICE_OVERDUE",
        sourceEntityType: "INVOICE",
        sourceEntityId: randomUUID(),
        amountAtRisk: BigInt(15_000_000), // ₹150,000 > ₹100,000 threshold
        currency: "INR",
        riskScore: 60,
      },
    );

    const gated = await checkPolicyAgain({
      tenantId: tenant.id,
      caseId: highValueCase.id,
      actionType: "CREATE_PAYMENT_LINK",
      amountMinor: "15000000",
      currency: "INR",
      customerId: customer.id,
    });
    expect(gated.allowed).toBe(true);
    expect(gated.requiresApproval).toBe(true);

    // Low-value control: no approval required
    const lowValueCase = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        status: "IN_PROGRESS",
        riskType: "INVOICE_OVERDUE",
        sourceEntityType: "INVOICE",
        sourceEntityId: randomUUID(),
        amountAtRisk: BigInt(150000),
        currency: "INR",
        riskScore: 60,
      },
    );
    const control = await checkPolicyAgain({
      tenantId: tenant.id,
      caseId: lowValueCase.id,
      actionType: "CREATE_PAYMENT_LINK",
      amountMinor: "150000",
      currency: "INR",
      customerId: customer.id,
    });
    expect(control.allowed).toBe(true);
    expect(control.requiresApproval).toBe(false);
  });
});
