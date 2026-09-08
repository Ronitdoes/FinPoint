/**
 * Chaos scenario: duplicate webhook ×50 concurrent (Spec 01 §21).
 *
 * Acceptance: exactly 1 ACCEPTED delivery, N≥1 DUPLICATE responses, a single
 * payment row (no duplicate charges/cases), and metric movements consistent
 * with the delivery counts.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { db, sql, findPaymentByProviderPaymentId } from "@repo/db";
import { apiConfig } from "@repo/config";
import { buildApp } from "../../../apps/backend/src/app";
import { NullBus } from "@repo/integrations";
import { resetChaosHarness } from "../harness/fault-points";
import { assertInvariants } from "../harness/assert-invariants";
import { counterValue, createChaosTenant } from "../harness/seed";

const STRIPE_SECRET = "whsec_chaos_dup_stripe_secret_123";

function stripeSignature(body: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

describe("chaos: duplicate webhook storm", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let tenantId: string;

  beforeAll(async () => {
    const tenant = await createChaosTenant("dupwebhook");
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

  it("50 concurrent identical Stripe deliveries → 1 ACCEPTED, 49 DUPLICATE, single payment", async () => {
    const externalId = `evt_chaos_dup_${randomUUID()}`;
    const paymentIntentId = `pi_chaos_dup_${randomUUID()}`;
    const customerRef = `cus_chaos_dup_${randomUUID()}`;

    const payload = JSON.stringify({
      id: externalId,
      type: "payment_intent.payment_failed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: paymentIntentId,
          amount: 7500,
          currency: "usd",
          customer: customerRef,
          customer_details: { name: "Chaos Dup", email: "dup@chaos.example.com" },
          last_payment_error: {
            code: "card_declined",
            decline_code: "insufficient_funds",
            message: "Insufficient balance",
          },
        },
      },
    });
    const sigHeader = stripeSignature(payload, STRIPE_SECRET);

    const dupBefore = await counterValue("webhook_deliveries_total", {
      provider: "STRIPE",
      status: "duplicate",
    });
    const acceptedBefore = await counterValue("webhook_deliveries_total", {
      provider: "STRIPE",
      status: "accepted",
    });

    const responses = await Promise.all(
      Array.from({ length: 50 }, () =>
        app.inject({
          method: "POST",
          url: `/webhooks/stripe?tenant_id=${tenantId}`,
          headers: {
            "content-type": "application/json",
            "stripe-signature": sigHeader,
          },
          payload,
        }),
      ),
    );

    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }
    const bodies = responses.map((res) => res.json() as { status: string; eventId: string });
    const accepted = bodies.filter((b) => b.status === "ACCEPTED");
    const duplicates = bodies.filter((b) => b.status === "DUPLICATE");

    expect(accepted).toHaveLength(1);
    expect(duplicates.length).toBeGreaterThanOrEqual(1);
    expect(accepted.length + duplicates.length).toBe(50);
    // Every duplicate echoes the single canonical event id.
    for (const dup of duplicates) {
      expect(dup.eventId).toBe(accepted[0].eventId);
    }

    // Exactly one payment row: no duplicate financial records.
    const payment = await findPaymentByProviderPaymentId(
      { db },
      { tenantId, provider: "STRIPE", providerPaymentId: paymentIntentId },
    );
    expect(payment).toBeDefined();
    const paymentRows = await db.execute(
      sql`SELECT id FROM payments WHERE tenant_id = ${tenantId} AND provider_payment_id = ${paymentIntentId}`,
    );
    expect(paymentRows.length).toBe(1);

    // Exactly one inbound event row.
    const eventRows = await db.execute(
      sql`SELECT id FROM events WHERE tenant_id = ${tenantId} AND external_event_id = ${externalId}`,
    );
    expect(eventRows.length).toBe(1);

    // Metrics consistent with delivery counts.
    expect(
      await counterValue("webhook_deliveries_total", { provider: "STRIPE", status: "duplicate" }) - dupBefore,
    ).toBe(duplicates.length);
    expect(
      await counterValue("webhook_deliveries_total", { provider: "STRIPE", status: "accepted" }) - acceptedBefore,
    ).toBe(1);

    await assertInvariants(tenantId);
  });
});
