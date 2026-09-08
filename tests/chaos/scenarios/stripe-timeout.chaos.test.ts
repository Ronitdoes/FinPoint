/**
 * Chaos scenario: Stripe timeout (Spec 01 §21).
 *
 * The provider hangs past the timeout budget on every network attempt, so the
 * execution resolves the attempt to UNKNOWN and the refresh path polls the
 * provider status to a terminal outcome. Acceptance: exactly one attempt row
 * (no duplicate charges), state converges to SUCCEEDED, provider metrics move.
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

/** Stripe stub: charges hang (timeout), status query reports late success. */
class HangingStripeAdapter implements PaymentProvider {
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
      status: "SUCCEEDED",
      providerReference: `stripe_ref_${id.slice(0, 8)}`,
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

describe("chaos: Stripe provider timeout", { timeout: 90000 }, () => {
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

  it("hang → UNKNOWN attempt → status poll converges to SUCCEEDED exactly once", async () => {
    const tenant = await createChaosTenant("stripetimeout");
    const tenantId = tenant.id;
    const customer = await createChaosCustomer(tenantId);
    const payment = await createChaosPayment(tenantId, customer.id, "stripe", {
      provider: "STRIPE",
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

    const providerCallsBefore =
      await counterValue("provider_calls_total", {
        provider: "STRIPE",
        op: "retryPayment",
        status: "error",
      }) +
      await counterValue("provider_calls_total", {
        provider: "stripe",
        op: "retryPayment",
        status: "error",
      });

    const adapter = new HangingStripeAdapter();
    const service = new PaymentExecutionService(app.db, app.repos, app.config, adapter);

    // Synchronous outcome: the hang resolves to UNKNOWN (never a blind guess).
    const result = await service.executeRetryPayment({
      tenantId,
      caseId: recoveryCase.id,
      paymentId: payment.id,
      attemptNumber: 1,
      actionId: action.id,
      timeoutMs: 300,
    });
    expect(result.outcome).toBe("UNKNOWN");

    const attemptNow = await findPaymentAttemptByIdempotencyKey(
      { db },
      { tenantId, idempotencyKey },
    );
    expect(attemptNow?.status).toBeDefined();
    // The background refresh poll may already have converged the attempt;
    // either UNKNOWN (poll pending) or SUCCEEDED (poll won the race) is legal
    // here — the waitFor below pins the terminal state.
    expect(["UNKNOWN", "SUCCEEDED"]).toContain(attemptNow?.status);

    // Background refresh polling converges to the provider's late success.
    await waitFor(
      async () => {
        const attempt = await findPaymentAttemptByIdempotencyKey(
          { db },
          { tenantId, idempotencyKey },
        );
        return attempt?.status === "SUCCEEDED";
      },
      { timeoutMs: 20000, label: "attempt resolves to SUCCEEDED via status poll" },
    );

    // Exactly one attempt row: the timeout never double-charged.
    const attempts = await findPaymentAttemptsByPaymentId(
      { db },
      { tenantId, paymentId: payment.id },
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0].status).toBe("SUCCEEDED");

    const updatedPayment = await findPaymentById({ db }, { tenantId, paymentId: payment.id });
    expect(updatedPayment?.status).toBe("SUCCEEDED");

    const updatedAction = await findActionById({ db }, { tenantId, actionId: action.id });
    expect(updatedAction?.status).toBe("EXECUTED");

    // Status was learned via polling (provider never returned synchronously).
    expect(adapter.statusCalls).toBeGreaterThanOrEqual(1);

    // Provider failure metrics reflect the incident.
    const providerCallsAfter =
      await counterValue("provider_calls_total", {
        provider: "STRIPE",
        op: "retryPayment",
        status: "error",
      }) +
      await counterValue("provider_calls_total", {
        provider: "stripe",
        op: "retryPayment",
        status: "error",
      });
    expect(providerCallsAfter - providerCallsBefore).toBeGreaterThanOrEqual(1);

    await assertInvariants(tenantId);
  });
});
