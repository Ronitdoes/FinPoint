/**
 * Chaos scenario: Razorpay timeout (Spec 01 §21).
 *
 * Mirrors the Stripe timeout drill against the Razorpay provider label, with a
 * terminal FAILED poll outcome to prove the failure path also converges
 * without duplicate attempts: hang → UNKNOWN → poll FAILED → action FAILED.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  db,
  findPaymentAttemptsByPaymentId,
  findPaymentAttemptByIdempotencyKey,
  findPaymentById,
  findActionById,
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
import { resetChaosHarness } from "../harness/fault-points";
import { assertInvariants } from "../harness/assert-invariants";
import {
  buildChaosApp,
  counterValue,
  createChaosCase,
  createChaosCustomer,
  createChaosPayment,
  createChaosTenant,
  waitFor,
} from "../harness/seed";

/** Razorpay stub: charges hang (timeout), status query reports terminal decline. */
class HangingRazorpayAdapter implements PaymentProvider {
  retryCalls = 0;
  statusCalls = 0;

  async retryPayment(_input: RetryPaymentInput): Promise<RetryPaymentResult> {
    this.retryCalls++;
    await new Promise((resolve) => setTimeout(resolve, 10000));
    return { status: "FAILED", failureCode: "processing_error" };
  }

  async getPaymentStatus(id: string): Promise<PaymentStatusResult> {
    this.statusCalls++;
    return {
      id,
      status: "FAILED",
      providerReference: `rzp_ref_${id.slice(0, 8)}`,
      failureCode: "do_not_honor",
      failureMessage: "Payment declined by bank (late status report)",
    };
  }

  async createPaymentLink(_input: CreatePaymentLinkInput): Promise<PaymentLinkResult> {
    return {
      paymentLinkId: "plink_chaos_rzp",
      url: "https://pay.chaos.example/l/plink_chaos_rzp",
      status: "ACTIVE",
    };
  }
}

describe("chaos: Razorpay provider timeout", { timeout: 90000 }, () => {
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

  it("hang → UNKNOWN attempt → status poll converges to FAILED exactly once", async () => {
    const tenant = await createChaosTenant("rzptimeout");
    const tenantId = tenant.id;
    const customer = await createChaosCustomer(tenantId);
    const payment = await createChaosPayment(tenantId, customer.id, "razorpay", {
      provider: "RAZORPAY",
    });
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

    const adapter = new HangingRazorpayAdapter();
    const service = new PaymentExecutionService(app.db, app.repos, app.config, adapter);

    const result = await service.executeRetryPayment({
      tenantId,
      caseId: recoveryCase.id,
      paymentId: payment.id,
      attemptNumber: 1,
      actionId: action.id,
      timeoutMs: 300,
    });
    expect(result.outcome).toBe("UNKNOWN");

    await waitFor(
      async () => {
        const attempt = await findPaymentAttemptByIdempotencyKey(
          { db },
          { tenantId, idempotencyKey },
        );
        if (attempt?.status !== "FAILED") return false;
        // Converge the action row too: the poll commits payment + attempt +
        // action atomically, so waiting on both guards against reading the
        // action before its write lands.
        const act = await findActionById({ db }, { tenantId, actionId: action.id });
        return act?.status === "FAILED";
      },
      { timeoutMs: 20000, label: "attempt + action resolve to FAILED via status poll" },
    );

    // Exactly one attempt row with the provider's decline taxonomy preserved.
    const attempts = await findPaymentAttemptsByPaymentId(
      { db },
      { tenantId, paymentId: payment.id },
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("FAILED");
    expect(attempts[0].failureCode).toBe("do_not_honor");

    const updatedPayment = await findPaymentById({ db }, { tenantId, paymentId: payment.id });
    expect(updatedPayment?.status).toBe("FAILED");

    const updatedAction = await findActionById({ db }, { tenantId, actionId: action.id });
    expect(updatedAction?.status).toBe("FAILED");

    expect(adapter.statusCalls).toBeGreaterThanOrEqual(1);

    // Provider call metrics reflect the incident under the Razorpay label.
    const providerErrors =
      await counterValue("provider_calls_total", {
        provider: "RAZORPAY",
        op: "retryPayment",
        status: "error",
      }) +
      await counterValue("provider_calls_total", {
        provider: "razorpay",
        op: "retryPayment",
        status: "error",
      });
    expect(providerErrors).toBeGreaterThanOrEqual(1);

    await assertInvariants(tenantId);
  });
});
