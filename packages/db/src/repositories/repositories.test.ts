import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db, queryClient, healthCheck } from "../client";
import { checkPendingMigrations } from "../migrate";
import { withTransaction } from "./tx";
import { DuplicateActionError, DuplicateMessageError } from "./errors";
import { createTenant } from "./tenants.repo";
import { createUser, findUserById } from "./users.repo";
import { createApiKey, findApiKeyByHash } from "./api-keys.repo";
import { createCustomer, findCustomerById, setCustomerOptOut } from "./customers.repo";
import { createPayment, findPaymentById, updatePaymentStatus } from "./payments.repo";
import { createPaymentAttempt, findPaymentAttemptsByPaymentId, resolvePaymentAttempt } from "./payment-attempts.repo";
import { createSubscription, findSubscriptionById, listSubscriptionsForCustomer } from "./subscriptions.repo";
import { createCheckout, recordCheckoutEvent, listCheckoutEvents, listCheckoutsForCustomer } from "./checkouts.repo";
import { createInvoice, recordInvoiceEvent, listInvoiceEvents, listInvoicesForCustomer } from "./invoices.repo";
import { insertEventIfNew, markEventProcessed } from "./events.repo";
import { createRevenueRisk, findLatestRiskForSubject } from "./risks.repo";
import {
  createCase,
  createCaseInTx,
  transitionCaseStatus,
  findCaseById,
  findLiveCaseByObligation,
  nextCaseNumber,
} from "./cases.repo";
import { createDecision, listDecisionsForCase } from "./decisions.repo";
import {
  insertAction,
  claimActionForExecution,
  completeAction,
  failAction,
  findActionById,
} from "./actions.repo";
import { createWorkflow, recordWorkflowEvent, listWorkflowEvents } from "./workflows.repo";
import {
  insertMessage,
  findMessageById,
  updateMessageStatus,
  recordDeliveryEvent,
  listDeliveryEvents,
  listMessagesForCustomer,
} from "./messages.repo";
import { createCustomerResponse, listResponsesForCustomer } from "./responses.repo";
import { createPromiseToPay, resolvePromise } from "./promises.repo";
import { createHumanTask, decideHumanTask, listPendingHumanTasks } from "./human-tasks.repo";
import {
  createPolicyRule,
  createPolicyVersion,
  recordPolicyEvaluation,
  findPolicyRuleByCode,
} from "./policies.repo";
import * as auditRepo from "./audit.repo";
import { recordAuditLog, listAuditLogs } from "./audit.repo";
import { recordCaseEvent, listCaseEvents } from "./case-events.repo";
import { recordOutcomeInTx, findOutcomeByCaseId, recordCostEntry, listCostEntriesForCase, findOutcomesByCaseIds } from "./outcomes.repo";
import { tryAcquire, complete, releaseLease, getResponseSnapshot } from "./idempotency.repo";
import { randomUUID } from "crypto";

describe("Step 06 — Repository Layer & Concurrency Guards", () => {
  let testTenantId: string;
  let testCustomerId: string;
  let testUserId: string;

  beforeAll(async () => {
    // Check database health
    const isHealthy = await healthCheck();
    expect(isHealthy).toBe(true);

    // Create a base test tenant, customer, and user
    const tenant = await createTenant({}, {
      name: "Step 06 Test Tenant",
      slug: `step-06-tenant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    });
    testTenantId = tenant.id;

    const customer = await createCustomer({}, {
      tenantId: testTenantId,
      name: "Test Customer",
      email: `cust-${Date.now()}@example.com`,
    });
    testCustomerId = customer.id;

    const user = await createUser({}, {
      tenantId: testTenantId,
      email: `user-${Date.now()}@example.com`,
      name: "Test Operator",
      role: "OPERATIONS",
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    // Cleanup will be handled by DB or test schema tear down
  });

  describe("1. Database Client & Migration Pipeline", () => {
    it("healthCheck returns true for active connection", async () => {
      const healthy = await healthCheck();
      expect(healthy).toBe(true);
    }, 15000);

    it("checkPendingMigrations detects that all migrations are applied", async () => {
      const checkResult = await checkPendingMigrations();
      expect(checkResult.hasPending).toBe(false);
      expect(checkResult.pendingCount).toBe(0);
      expect(checkResult.appliedCount).toBeGreaterThanOrEqual(2);
    }, 15000);
  });

  describe("2. Explicit Transaction Wrapper (withTransaction)", () => {
    it("commits atomic multi-repository writes inside a transaction", async () => {
      const outcome = await withTransaction(async (tx) => {
        const c = await createCaseInTx(tx, {
          tenantId: testTenantId,
          customerId: testCustomerId,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "payments",
          sourceEntityId: randomUUID(),
          amountAtRisk: 500000n,
          currency: "INR",
          riskScore: 75,
        });

        await recordCaseEvent({ tx }, {
          tenantId: testTenantId,
          caseId: c.id,
          eventType: "CASE_OPENED",
          actorType: "SYSTEM",
          description: "Case opened via transaction",
        });

        return c;
      });

      expect(outcome.id).toBeDefined();
      const loaded = await findCaseById({}, { tenantId: testTenantId, caseId: outcome.id });
      expect(loaded).not.toBeNull();
      expect(loaded?.amountAtRisk).toBe(500000n);

      const events = await listCaseEvents({}, { tenantId: testTenantId, caseId: outcome.id });
      expect(events.length).toBe(1);
      expect(events[0].eventType).toBe("CASE_OPENED");
    }, 15000);

    it("rolls back all changes when an exception is thrown inside withTransaction", async () => {
      const sourceEntityId = randomUUID();

      await expect(
        withTransaction(async (tx) => {
          await createCaseInTx(tx, {
            tenantId: testTenantId,
            customerId: testCustomerId,
            riskType: "PAYMENT_FAILURE",
            sourceEntityType: "payments",
            sourceEntityId,
            amountAtRisk: 100000n,
            currency: "INR",
            riskScore: 80,
          });

          throw new Error("Simulated transaction failure");
        }),
      ).rejects.toThrow("Simulated transaction failure");

      const live = await findLiveCaseByObligation({}, {
        tenantId: testTenantId,
        sourceEntityType: "payments",
        sourceEntityId,
      });
      expect(live).toBeNull();
    }, 15000);
  });

  describe("3. Concurrency Primitive: Monotonic Case Sequencing (nextCaseNumber)", () => {
    it("generates collision-free monotonic case numbers per tenant under parallel creation", async () => {
      const isolatedTenant = await createTenant({}, {
        name: "Seq Tenant",
        slug: `seq-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      });

      const customer = await createCustomer({}, {
        tenantId: isolatedTenant.id,
        name: "Customer Seq",
      });

      const promises = Array.from({ length: 5 }, () =>
        withTransaction(async (tx) => {
          return await createCaseInTx(tx, {
            tenantId: isolatedTenant.id,
            customerId: customer.id,
            riskType: "PAYMENT_FAILURE",
            sourceEntityType: "payments",
            sourceEntityId: randomUUID(),
            amountAtRisk: 100000n,
            currency: "INR",
            riskScore: 50,
          });
        }),
      );

      const cases = await Promise.all(promises);
      const seqs = cases.map((c) => c.caseNumber);
      const sorted = [...seqs].sort((a, b) => a - b);
      expect(sorted).toEqual([1, 2, 3, 4, 5]);
    }, 20000);
  });

  describe("4. Guarded Case Transitions (transitionCaseStatus)", () => {
    it("successfully transitions case status when current status is in allowed 'from' set", async () => {
      const newCase = await createCase({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "payments",
        sourceEntityId: randomUUID(),
        amountAtRisk: 250000n,
        currency: "INR",
        riskScore: 65,
        status: "DETECTED",
      });

      const transitioned = await transitionCaseStatus({}, {
        tenantId: testTenantId,
        caseId: newCase.id,
        from: ["DETECTED"],
        to: "QUALIFIED",
        reason: "Customer risk verified",
      });

      expect(transitioned).not.toBeNull();
      expect(transitioned?.status).toBe("QUALIFIED");
      expect(transitioned?.statusReason).toBe("Customer risk verified");
    }, 15000);

    it("returns null and leaves row untouched when transition is invalid or raced", async () => {
      const newCase = await createCase({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "payments",
        sourceEntityId: randomUUID(),
        amountAtRisk: 250000n,
        currency: "INR",
        riskScore: 65,
        status: "DETECTED",
      });

      // Attempt invalid transition: from IN_PROGRESS -> RECOVERED when current is DETECTED
      const result = await transitionCaseStatus({}, {
        tenantId: testTenantId,
        caseId: newCase.id,
        from: ["IN_PROGRESS"],
        to: "RECOVERED",
      });

      expect(result).toBeNull();

      // Verify case status was unchanged
      const current = await findCaseById({}, { tenantId: testTenantId, caseId: newCase.id });
      expect(current?.status).toBe("DETECTED");
    }, 15000);
  });

  describe("5. Parallel Obligation Race & Anti-Duplication Anchors", () => {
    it("Parallel createCaseInTx x10 on same obligation -> exactly 1 success, 9 constraint violations", async () => {
      const sharedObligationId = randomUUID();

      const attempts = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          withTransaction(async (tx) => {
            return await createCaseInTx(tx, {
              tenantId: testTenantId,
              customerId: testCustomerId,
              riskType: "PAYMENT_FAILURE",
              sourceEntityType: "payments",
              sourceEntityId: sharedObligationId,
              amountAtRisk: 100000n,
              currency: "INR",
              riskScore: 70,
            });
          }),
        ),
      );

      const fulfilled = attempts.filter((r) => r.status === "fulfilled");
      const rejected = attempts.filter((r) => r.status === "rejected");

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(9);
    }, 30000);
  });

  describe("6. Action Lifecycle & Execution Claim Race", () => {
    it("Parallel claimActionForExecution x2 -> exactly 1 non-null claim", async () => {
      const c = await createCase({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "payments",
        sourceEntityId: randomUUID(),
        amountAtRisk: 150000n,
        currency: "INR",
        riskScore: 60,
      });

      const action = await insertAction({}, {
        tenantId: testTenantId,
        caseId: c.id,
        type: "RETRY_PAYMENT",
        parameters: { attempt_number: 1 },
        idempotencyKey: `claim-race-${Date.now()}-${randomUUID()}`,
        status: "APPROVED",
      });

      const [claim1, claim2] = await Promise.all([
        claimActionForExecution({}, { tenantId: testTenantId, actionId: action.id }),
        claimActionForExecution({}, { tenantId: testTenantId, actionId: action.id }),
      ]);

      const winners = [claim1, claim2].filter((res) => res !== null);
      const losers = [claim1, claim2].filter((res) => res === null);

      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      expect(winners[0]?.status).toBe("EXECUTING");
    }, 15000);

    it("transitions EXECUTING action to EXECUTED or FAILED conditionally", async () => {
      const c = await createCase({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "payments",
        sourceEntityId: randomUUID(),
        amountAtRisk: 150000n,
        currency: "INR",
        riskScore: 60,
      });

      const action = await insertAction({}, {
        tenantId: testTenantId,
        caseId: c.id,
        type: "SEND_WHATSAPP",
        parameters: { template_id: "tpl_1" },
        idempotencyKey: `exec-test-${Date.now()}-${randomUUID()}`,
        status: "PROPOSED",
      });

      // Claim action
      const claimed = await claimActionForExecution({}, { tenantId: testTenantId, actionId: action.id });
      expect(claimed?.status).toBe("EXECUTING");

      // Complete action
      const completed = await completeAction({}, {
        tenantId: testTenantId,
        actionId: action.id,
        result: { provider_id: "wa_msg_123" },
      });
      expect(completed?.status).toBe("EXECUTED");
      expect(completed?.result).toEqual({ provider_id: "wa_msg_123" });

      // Cannot fail an already EXECUTED action (must be EXECUTING)
      const failedAfterComplete = await failAction({}, {
        tenantId: testTenantId,
        actionId: action.id,
        error: { message: "late failure" },
      });
      expect(failedAfterComplete).toBeNull();
    }, 15000);

    it("throws DuplicateActionError on unique idempotency key conflict", async () => {
      const c = await createCase({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "payments",
        sourceEntityId: randomUUID(),
        amountAtRisk: 100000n,
        currency: "INR",
        riskScore: 50,
      });

      const sharedKey = `dup-action-${Date.now()}-${randomUUID()}`;

      await insertAction({}, {
        tenantId: testTenantId,
        caseId: c.id,
        type: "OFFER_INCENTIVE",
        parameters: { discount_percent: 10 },
        idempotencyKey: sharedKey,
      });

      await expect(
        insertAction({}, {
          tenantId: testTenantId,
          caseId: c.id,
          type: "OFFER_INCENTIVE",
          parameters: { discount_percent: 15 },
          idempotencyKey: sharedKey,
        }),
      ).rejects.toThrow(DuplicateActionError);
    }, 15000);
  });

  describe("7. Messages & Duplicate Protection", () => {
    it("throws DuplicateMessageError on message idempotency key conflict", async () => {
      const key = `dup-msg-${Date.now()}-${randomUUID()}`;

      await insertMessage({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        channel: "EMAIL",
        templateId: "tpl_invoice_reminder",
        toAddress: "customer@example.com",
        provider: "SMTP_EMAIL",
        idempotencyKey: key,
      });

      await expect(
        insertMessage({}, {
          tenantId: testTenantId,
          customerId: testCustomerId,
          channel: "EMAIL",
          templateId: "tpl_invoice_reminder",
          toAddress: "customer@example.com",
          provider: "SMTP_EMAIL",
          idempotencyKey: key,
        }),
      ).rejects.toThrow(DuplicateMessageError);
    }, 15000);

    it("updateMessageStatus enforces legal transitions and returns null on illegal/terminal writes", async () => {
      const msg = await insertMessage({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        channel: "WHATSAPP",
        templateId: "guard_test",
        toAddress: "+14155550001",
        provider: "MOCK",
        idempotencyKey: `guard-msg-${Date.now()}-${randomUUID()}`,
      });
      expect(msg.status).toBe("QUEUED");

      // Illegal skip: QUEUED -> READ must be refused, row untouched
      const skipped = await updateMessageStatus({}, {
        tenantId: testTenantId,
        messageId: msg.id,
        status: "READ",
      });
      expect(skipped).toBeNull();
      expect(
        (await findMessageById({}, { tenantId: testTenantId, messageId: msg.id }))?.status,
      ).toBe("QUEUED");

      // Legal chain: QUEUED -> SENT -> DELIVERED -> READ
      const sent = await updateMessageStatus({}, {
        tenantId: testTenantId,
        messageId: msg.id,
        status: "SENT",
        providerMessageId: `wa_${randomUUID()}`,
        sentAt: new Date(),
      });
      expect(sent?.status).toBe("SENT");

      const delivered = await updateMessageStatus({}, {
        tenantId: testTenantId,
        messageId: msg.id,
        status: "DELIVERED",
      });
      expect(delivered?.status).toBe("DELIVERED");

      const read = await updateMessageStatus({}, {
        tenantId: testTenantId,
        messageId: msg.id,
        status: "READ",
      });
      expect(read?.status).toBe("READ");

      // Terminal: READ -> FAILED must be refused, row stays READ
      const raced = await updateMessageStatus({}, {
        tenantId: testTenantId,
        messageId: msg.id,
        status: "FAILED",
        finalStatusAt: new Date(),
      });
      expect(raced).toBeNull();
      expect(
        (await findMessageById({}, { tenantId: testTenantId, messageId: msg.id }))?.status,
      ).toBe("READ");
    }, 15000);

    it("updateMessageStatus allows QUEUED->FAILED and SENT->REJECTED, then freezes terminals", async () => {
      const failMsg = await insertMessage({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        channel: "EMAIL",
        templateId: "guard_fail_test",
        toAddress: "guard@example.com",
        provider: "MOCK",
        idempotencyKey: `guard-fail-${Date.now()}-${randomUUID()}`,
      });

      const failed = await updateMessageStatus({}, {
        tenantId: testTenantId,
        messageId: failMsg.id,
        status: "FAILED",
        finalStatusAt: new Date(),
      });
      expect(failed?.status).toBe("FAILED");

      // Terminal: FAILED -> DELIVERED must be refused
      const afterFailed = await updateMessageStatus({}, {
        tenantId: testTenantId,
        messageId: failMsg.id,
        status: "DELIVERED",
      });
      expect(afterFailed).toBeNull();

      const rejectMsg = await insertMessage({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        channel: "EMAIL",
        templateId: "guard_reject_test",
        toAddress: "guard@example.com",
        provider: "MOCK",
        idempotencyKey: `guard-reject-${Date.now()}-${randomUUID()}`,
      });

      const sent = await updateMessageStatus({}, {
        tenantId: testTenantId,
        messageId: rejectMsg.id,
        status: "SENT",
        providerMessageId: `mail_${randomUUID()}`,
        sentAt: new Date(),
      });
      expect(sent?.status).toBe("SENT");

      const rejected = await updateMessageStatus({}, {
        tenantId: testTenantId,
        messageId: rejectMsg.id,
        status: "REJECTED",
      });
      expect(rejected?.status).toBe("REJECTED");

      // Terminal: REJECTED -> READ must be refused
      const afterRejected = await updateMessageStatus({}, {
        tenantId: testTenantId,
        messageId: rejectMsg.id,
        status: "READ",
      });
      expect(afterRejected).toBeNull();
    }, 15000);
  });

  describe("8. Webhook Ingestion & Deduplication (events.repo)", () => {
    it("insertEventIfNew flags duplicate external event IDs", async () => {
      const extId = `ext-evt-${Date.now()}-${randomUUID()}`;

      const first = await insertEventIfNew({}, {
        tenantId: testTenantId,
        source: "STRIPE",
        externalEventId: extId,
        type: "payment.failed",
        rawPayload: { id: extId },
        payload: { amount: 5000 },
        correlationId: randomUUID(),
      });

      expect(first.duplicate).toBe(false);
      expect(first.event.externalEventId).toBe(extId);

      const second = await insertEventIfNew({}, {
        tenantId: testTenantId,
        source: "STRIPE",
        externalEventId: extId,
        type: "payment.failed",
        rawPayload: { id: extId },
        payload: { amount: 5000 },
        correlationId: randomUUID(),
      });

      expect(second.duplicate).toBe(true);
      expect(second.event.id).toBe(first.event.id);
    }, 15000);
  });

  describe("9. Outcome Recording Idempotency (recordOutcomeInTx)", () => {
    it("recordOutcomeInTx twice on same case -> second is idempotent no-op returning existing row", async () => {
      const c = await createCase({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "payments",
        sourceEntityId: randomUUID(),
        amountAtRisk: 1000000n,
        currency: "INR",
        riskScore: 50,
      });

      const payment = await createPayment({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        amount: 1000000n,
        currency: "INR",
        provider: "RAZORPAY",
        providerPaymentId: `pay_recov_${Date.now()}_${randomUUID().slice(0, 8)}`,
        occurredAt: new Date(),
      });

      const outcome1 = await withTransaction(async (tx) => {
        return await recordOutcomeInTx(tx, {
          tenantId: testTenantId,
          caseId: c.id,
          paymentId: payment.id,
          baselineAmount: 1000000n,
          recoveredAmount: 1000000n,
          recoveryCost: 50000n,
          attributionMethod: "DIRECT_PAYMENT_RETRY",
          attributionWindowHours: 72,
          recoveredAt: new Date(),
        });
      });

      const outcome2 = await withTransaction(async (tx) => {
        return await recordOutcomeInTx(tx, {
          tenantId: testTenantId,
          caseId: c.id,
          paymentId: payment.id,
          baselineAmount: 1000000n,
          recoveredAmount: 1000000n,
          recoveryCost: 50000n,
          attributionMethod: "DIRECT_PAYMENT_RETRY",
          attributionWindowHours: 72,
          recoveredAt: new Date(),
        });
      });

      expect(outcome1.id).toBe(outcome2.id);
      expect(outcome1.netRecovered).toBe(950000n);
      expect(outcome2.netRecovered).toBe(950000n);
    }, 15000);
  });

  describe("10. General Idempotency Store (tryAcquire / complete)", () => {
    it("implements lease acquisition, concurrent in-flight check, and mismatch rejection", async () => {
      const key = `idem-test-${Date.now()}-${randomUUID()}`;
      const hash1 = "hash-request-payload-v1";
      const hash2 = "hash-request-payload-v2";

      // 1. Initial acquire -> ACQUIRED
      const res1 = await tryAcquire({}, { key, requestHash: hash1, ttlSeconds: 10 });
      expect(res1).toBe("ACQUIRED");

      // 2. Concurrent duplicate with same hash -> IN_FLIGHT
      const res2 = await tryAcquire({}, { key, requestHash: hash1, ttlSeconds: 10 });
      expect(res2).toBe("IN_FLIGHT");

      // 3. Different payload under same key -> COMPLETED_DIFFERENT
      const res3 = await tryAcquire({}, { key, requestHash: hash2, ttlSeconds: 10 });
      expect(res3).toBe("COMPLETED_DIFFERENT");

      // 4. Complete key
      await complete({}, {
        key,
        responseSnapshot: { success: true, transactionId: "tx_123" },
      });

      const snapshot = await getResponseSnapshot({}, { key });
      expect(snapshot).toEqual({ success: true, transactionId: "tx_123" });
    }, 15000);
  });

  describe("11. Append-Only Guarantees & Other Aggregate Repositories", () => {
    it("records and reads audit logs without update capabilities", async () => {
      const audit = await recordAuditLog({}, {
        tenantId: testTenantId,
        actorType: "AI",
        actorId: "agent-v1",
        event: "MODEL_DECISION_GENERATED",
        metadata: { model: "gemini-1.5-pro", latency: 120 },
      });

      expect(audit.id).toBeDefined();
      const logs = await listAuditLogs({}, { tenantId: testTenantId });
      expect(logs.some((l) => l.id === audit.id)).toBe(true);
    }, 15000);

    it("verifies type-level absence of update methods on append-only repositories", () => {
      // Type test: ensure updateAuditLog is not exported on auditRepo module
      const repoExports = auditRepo as Record<string, unknown>;
      expect(repoExports.updateAuditLog).toBeUndefined();
      expect(repoExports.deleteAuditLog).toBeUndefined();
    });

    it("records and reads promises to pay and human tasks", async () => {
      const c = await createCase({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        riskType: "INVOICE_OVERDUE",
        sourceEntityType: "invoices",
        sourceEntityId: randomUUID(),
        amountAtRisk: 300000n,
        currency: "INR",
        riskScore: 40,
      });

      const promise = await createPromiseToPay({}, {
        tenantId: testTenantId,
        caseId: c.id,
        promisedAmount: 300000n,
        currency: "INR",
        promisedByDate: "2026-09-15",
      });
      expect(promise.id).toBeDefined();

      const resolved = await resolvePromise({}, {
        tenantId: testTenantId,
        promiseId: promise.id,
        status: "HONORED",
      });
      expect(resolved?.status).toBe("HONORED");

      const task = await createHumanTask({}, {
        tenantId: testTenantId,
        caseId: c.id,
        type: "APPROVAL",
        title: "Approve 20% discount offer",
      });
      expect(task.id).toBeDefined();

      const decided = await decideHumanTask({}, {
        tenantId: testTenantId,
        taskId: task.id,
        status: "APPROVED",
        decidedBy: testUserId,
        decisionNotes: "Approved by manager",
      });
      expect(decided?.status).toBe("APPROVED");
    }, 15000);

    it("lists customer-scoped invoices, checkouts, messages, and outcomes", async () => {
      // 1. Invoices
      const inv = await createInvoice({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        number: `INV-CUST-${randomUUID().slice(0, 8)}`,
        amount: 3000n,
        currency: "USD",
        dueAt: new Date(),
      });
      const customerInvoices = await listInvoicesForCustomer({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
      });
      expect(customerInvoices.some((i) => i.id === inv.id)).toBe(true);

      // 2. Checkouts
      const chk = await createCheckout({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        currency: "USD",
        cartValue: 4500n,
        startedAt: new Date(),
        lastActivityAt: new Date(),
      });
      const customerCheckouts = await listCheckoutsForCustomer({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
      });
      expect(customerCheckouts.some((c) => c.id === chk.id)).toBe(true);

      // 3. Messages
      const msg = await insertMessage({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        channel: "WHATSAPP",
        templateId: "reminder_1",
        toAddress: "+14155550000",
        provider: "MOCK",
        idempotencyKey: `msg_${randomUUID()}`,
      });
      const customerMessages = await listMessagesForCustomer({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
      });
      expect(customerMessages.some((m) => m.id === msg.id)).toBe(true);

      // 4. Outcomes
      const pay = await createPayment({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        amount: 1000n,
        currency: "USD",
        status: "SUCCEEDED",
        provider: "STRIPE",
        providerPaymentId: `pi_test_${randomUUID()}`,
        occurredAt: new Date(),
      });
      const c = await createCase({}, {
        tenantId: testTenantId,
        customerId: testCustomerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "payments",
        sourceEntityId: pay.id,
        amountAtRisk: 1000n,
        currency: "USD",
        riskScore: 50,
      });
      await withTransaction(async (tx) => {
        await recordOutcomeInTx(tx, {
          tenantId: testTenantId,
          caseId: c.id,
          paymentId: pay.id,
          baselineAmount: 1000n,
          recoveredAmount: 1000n,
          attributionMethod: "DIRECT",
          attributionWindowHours: 72,
          recoveredAt: new Date(),
        });
      });
      const outcomes = await findOutcomesByCaseIds({}, {
        tenantId: testTenantId,
        caseIds: [c.id],
      });
      expect(outcomes.length).toBe(1);
      expect(outcomes[0].caseId).toBe(c.id);
    }, 15000);
  });
});

