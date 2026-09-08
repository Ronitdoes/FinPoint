/**
 * Chaos scenario: Temporal worker crash (Spec 01 §21).
 *
 * A SIGKILL lands exactly between claim and provider call (fault-point
 * `claim:after_claim`), leaving an EXECUTING action plus a REQUESTED attempt.
 * Acceptance:
 * - the provider is never called by the crashed execution;
 * - resume completes the action with the provider called EXACTLY once;
 * - the EXECUTING sweeper resolves stuck rows via status query and NEVER
 *   blindly re-executes (provider charge count stays zero on the sweep path).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  db,
  createPaymentAttempt,
  findActionById,
  findPaymentAttemptByIdempotencyKey,
  findPaymentAttemptsByPaymentId,
  findPaymentById,
  insertAction,
} from "@repo/db";
import type {
  CreatePaymentLinkInput,
  PaymentLinkResult,
  PaymentProvider,
  PaymentStatusResult,
  RetryPaymentInput,
  RetryPaymentResult,
} from "@repo/integrations";
import { PaymentExecutionService } from "../../../apps/backend/src/modules/payments";
import { ExecutingSweeper } from "../../../apps/backend/src/jobs/executing-sweeper";
import {
  FaultInjectedError,
  armFaultPoint,
  resetChaosHarness,
} from "../harness/fault-points";
import { drillKillWorker } from "../harness/compose-admin";
import { assertInvariants } from "../harness/assert-invariants";
import {
  buildChaosApp,
  counterValue,
  createChaosCase,
  createChaosCustomer,
  createChaosPayment,
  createChaosTenant,
} from "../harness/seed";

/** Counting mock: succeeds synchronously, records every charge. */
class CountingProvider implements PaymentProvider {
  charges = 0;
  statusQueries = 0;

  async retryPayment(_input: RetryPaymentInput): Promise<RetryPaymentResult> {
    this.charges++;
    return {
      status: "SUCCEEDED",
      providerReference: `mock_charge_${this.charges}`,
      fee: { amount: 250n, currency: "USD" },
    };
  }

  async getPaymentStatus(id: string): Promise<PaymentStatusResult> {
    this.statusQueries++;
    return {
      id,
      status: "SUCCEEDED",
      providerReference: `mock_ref_${id.slice(0, 8)}`,
      fee: { amount: 250n, currency: "USD" },
      paidAt: new Date(),
    };
  }

  async createPaymentLink(_input: CreatePaymentLinkInput): Promise<PaymentLinkResult> {
    return {
      paymentLinkId: "plink_chaos",
      url: "https://pay.chaos.example/l/plink_chaos",
      status: "ACTIVE",
    };
  }
}

describe("chaos: worker crash mid-flight", { timeout: 90000 }, () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildChaosApp());
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(() => {
    resetChaosHarness();
  });

  it("SIGKILL after claim, before provider call → resume executes EXACTLY once", async () => {
    const tenant = await createChaosTenant("workercrash");
    const tenantId = tenant.id;
    const customer = await createChaosCustomer(tenantId);
    const payment = await createChaosPayment(tenantId, customer.id, "crash");
    const recoveryCase = await createChaosCase(tenantId, customer.id, payment, {
      status: "IN_PROGRESS",
    });

    const idempotencyKey = `${tenantId}:${recoveryCase.id}:RETRY_PAYMENT:1`;
    const action = await insertAction(
      { db },
      {
        tenantId,
        caseId: recoveryCase.id,
        type: "RETRY_PAYMENT",
        parameters: {},
        status: "APPROVED",
        attemptNumber: 1,
        idempotencyKey,
      },
    );

    const adapter = new CountingProvider();
    const service = new PaymentExecutionService(app.db, app.repos, app.config, adapter);
    const faultsBefore = await counterValue("chaos_faults_injected_total", {
      fault: "claim",
      phase: "after_claim",
    });

    // Crash window armed: the process "dies" right after the claim.
    armFaultPoint("claim", "after_claim", { kind: "throw-crash" });
    await expect(
      service.executeRetryPayment({
        tenantId,
        caseId: recoveryCase.id,
        paymentId: payment.id,
        attemptNumber: 1,
        actionId: action.id,
        timeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(FaultInjectedError);

    // Crashed execution never reached the provider…
    expect(adapter.charges).toBe(0);
    expect(
      await counterValue("chaos_faults_injected_total", {
        fault: "claim",
        phase: "after_claim",
      }) - faultsBefore,
    ).toBe(1);

    // …but the claim + REQUESTED attempt survived (durable intent).
    const stuckAction = await findActionById({ db }, { tenantId, actionId: action.id });
    expect(stuckAction?.status).toBe("EXECUTING");
    const stuckAttempt = await findPaymentAttemptByIdempotencyKey(
      { db },
      { tenantId, idempotencyKey },
    );
    expect(stuckAttempt?.status).toBe("REQUESTED");

    // Resume (Temporal replay analogue): the SAME idempotency key completes once.
    resetChaosHarness();
    const resumed = await service.executeRetryPayment({
      tenantId,
      caseId: recoveryCase.id,
      paymentId: payment.id,
      attemptNumber: 1,
      actionId: action.id,
      timeoutMs: 5000,
    });
    expect(resumed.outcome).toBe("SUCCEEDED");

    // Provider called EXACTLY once across crash + resume.
    expect(adapter.charges).toBe(1);
    const attempts = await findPaymentAttemptsByPaymentId(
      { db },
      { tenantId, paymentId: payment.id },
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("SUCCEEDED");

    const done = await findActionById({ db }, { tenantId, actionId: action.id });
    expect(done?.status).toBe("EXECUTED");

    const paid = await findPaymentById({ db }, { tenantId, paymentId: payment.id });
    expect(paid?.status).toBe("SUCCEEDED");

    await assertInvariants(tenantId);
  });

  it("EXECUTING sweeper resolves stuck rows via status query, never re-executes", async () => {
    const tenant = await createChaosTenant("sweepcrash");
    const tenantId = tenant.id;
    const customer = await createChaosCustomer(tenantId);
    const payment = await createChaosPayment(tenantId, customer.id, "sweep");
    const recoveryCase = await createChaosCase(tenantId, customer.id, payment, {
      status: "IN_PROGRESS",
    });

    // Induced stuck row: claimed action + REQUESTED attempt (crash aftermath).
    const idempotencyKey = `${tenantId}:${recoveryCase.id}:RETRY_PAYMENT:7`;
    const action = await insertAction(
      { db },
      {
        tenantId,
        caseId: recoveryCase.id,
        type: "RETRY_PAYMENT",
        parameters: {},
        status: "EXECUTING",
        startedAt: new Date(Date.now() - 30 * 60 * 1000),
        attemptNumber: 7,
        idempotencyKey,
      },
    );
    await createPaymentAttempt(
      { db },
      {
        tenantId,
        paymentId: payment.id,
        attemptNumber: 7,
        initiatedBy: "RECOVERY_WORKFLOW",
        idempotencyKey,
        status: "REQUESTED",
        requestedAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    );

    const adapter = new CountingProvider();
    const sweeper = new ExecutingSweeper(app.db, app.repos, app.config, adapter);
    const sweepsBefore = await counterValue("executing_sweeper_actions_total", {
      result: "completed",
    });

    const result = await sweeper.runSweep({
      tenantId,
      stuckSeconds: 60,
      statusResolver: async () => ({
        id: payment.providerPaymentId ?? payment.id,
        status: "SUCCEEDED",
        providerReference: "mock_late_success",
        fee: { amount: 250n, currency: "USD" },
        paidAt: new Date(),
      }),
    });

    expect(result.actionsAudited).toBe(1);
    expect(result.actionsCompleted).toBe(1);
    expect(result.actionsFailed).toBe(0);

    // The sweeper NEVER charges: provider retry path untouched.
    expect(adapter.charges).toBe(0);

    const resolved = await findActionById({ db }, { tenantId, actionId: action.id });
    expect(resolved?.status).toBe("EXECUTED");
    const attempt = await findPaymentAttemptByIdempotencyKey(
      { db },
      { tenantId, idempotencyKey },
    );
    expect(attempt?.status).toBe("SUCCEEDED");

    expect(
      await counterValue("executing_sweeper_actions_total", { result: "completed" }) - sweepsBefore,
    ).toBe(1);

    await assertInvariants(tenantId);
  });

  it("compose SIGKILL drill is admin-guarded and skipped without CHAOS_INFRA", () => {
    const report = drillKillWorker();
    expect(report.drill).toBe("worker-crash");
    expect(report.skipped).toBe(true);
  });
});
