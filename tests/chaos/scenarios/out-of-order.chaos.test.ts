/**
 * Chaos scenario: out-of-order events succeeded → failed → failed (Spec 01 §21).
 *
 * Acceptance: final status stays SUCCEEDED (no regression), the regression
 * counter increments twice, and invariants hold.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db, findPaymentByProviderPaymentId } from "@repo/db";
import { apiConfig } from "@repo/config";
import { buildApp } from "../../../apps/backend/src/app";
import { NullBus } from "@repo/integrations";
import { resetChaosHarness } from "../harness/fault-points";
import { assertInvariants } from "../harness/assert-invariants";
import { counterValue, createChaosTenant } from "../harness/seed";

const STRIPE_SECRET = "whsec_chaos_ooo_stripe_secret_123";

function stripeSignature(body: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

describe("chaos: out-of-order succeeded→failed→failed", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let tenantId: string;

  beforeAll(async () => {
    const tenant = await createChaosTenant("outoforder");
    tenantId = tenant.id;

    const baseConfig = apiConfig();
    app = await buildApp({
      eventBus: new NullBus(),
      disableRateLimit: true,
      logger: false,
      config: {
        ...baseConfig,
        payments: { ...baseConfig.payments, stripeWebhookSecret: STRIPE_SECRET },
      },
    });
    await app.ready();
  }, 45000);

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(() => {
    resetChaosHarness();
  });

  async function postStripe(payload: string): Promise<{ status: string; eventId: string }> {
    const res = await app.inject({
      method: "POST",
      url: `/webhooks/stripe?tenant_id=${tenantId}`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripeSignature(payload, STRIPE_SECRET),
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { status: string; eventId: string };
  }

  it("late failure deliveries never regress a succeeded payment", async () => {
    const paymentIntentId = `pi_chaos_ooo_${randomUUID()}`;
    const customerRef = `cus_chaos_ooo_${randomUUID()}`;
    const baseObject = {
      id: paymentIntentId,
      amount: 9200,
      currency: "usd",
      customer: customerRef,
      customer_details: { name: "Chaos OOO", email: "ooo@chaos.example.com" },
    };

    // 1. Success arrives FIRST (newest truth).
    const succeeded = await postStripe(
      JSON.stringify({
        id: `evt_chaos_ooo_ok_${randomUUID()}`,
        type: "payment_intent.succeeded",
        created: Math.floor(Date.now() / 1000),
        data: { object: baseObject },
      }),
    );
    expect(succeeded.status).toBe("ACCEPTED");

    const regressionBefore = await counterValue("event_order_regression_total", {
      provider: "STRIPE",
      entity_type: "PAYMENT",
      from_status: "SUCCEEDED",
      to_status: "FAILED",
    });

    // 2 + 3. Two stale failure deliveries arrive late.
    for (let i = 0; i < 2; i++) {
      const late = await postStripe(
        JSON.stringify({
          id: `evt_chaos_ooo_late_${i}_${randomUUID()}`,
          type: "payment_intent.payment_failed",
          created: Math.floor(Date.now() / 1000) - 3600,
          data: {
            object: {
              ...baseObject,
              last_payment_error: {
                code: "card_declined",
                decline_code: "insufficient_funds",
                message: "Stale failure redelivery",
              },
            },
          },
        }),
      );
      expect(late.status).toBe("ACCEPTED");
    }

    // Final status converges to SUCCEEDED — never regresses.
    const payment = await findPaymentByProviderPaymentId(
      { db },
      { tenantId, provider: "STRIPE", providerPaymentId: paymentIntentId },
    );
    expect(payment).toBeDefined();
    expect(payment!.status).toBe("SUCCEEDED");

    // Regression counter incremented twice (once per stale delivery).
    expect(
      await counterValue("event_order_regression_total", {
        provider: "STRIPE",
        entity_type: "PAYMENT",
        from_status: "SUCCEEDED",
        to_status: "FAILED",
      }) - regressionBefore,
    ).toBe(2);

    await assertInvariants(tenantId);
  });
});
