import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { buildApp } from "../app";
import { NullBus } from "@repo/integrations";
import { db, createTenant } from "@repo/db";
import type { FastifyInstance } from "fastify";
import { apiConfig } from "@repo/config";

describe("zz-debug", { timeout: 30000 }, () => {
  let app: FastifyInstance;
  let testTenantId: string;
  const stripeSecret = "whsec_integration_test_stripe_secret_123";
  const razorpaySecret = "rzp_sec_integration_test_razorpay_secret_456";

  function createStripeSignature(body: string, secret: string): string {
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    return `t=${ts},v1=${sig}`;
  }

  beforeAll(async () => {
    const tenant = await createTenant(
      { db },
      { name: `Dbg ${randomUUID().slice(0, 8)}`, slug: `dbg-${randomUUID().slice(0, 8)}` },
    );
    testTenantId = tenant.id;
    const baseConfig = apiConfig();
    app = await buildApp({
      eventBus: new NullBus(),
      disableRateLimit: true,
      logger: false,
      config: {
        ...baseConfig,
        payments: {
          ...baseConfig.payments,
          stripeWebhookSecret: stripeSecret,
          razorpayWebhookSecret: razorpaySecret,
        },
      },
    });
    await app.ready();
  }, 45000);

  afterAll(async () => {
    await app?.close();
  });

  it("prints webhook error body", async () => {
    const { processInboundWebhook } = await import("../modules/webhooks/ingest.service");
    const payload = JSON.stringify({
      id: `evt_dbg_${randomUUID()}`,
      type: "payment_intent.payment_failed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `pi_dbg_${randomUUID()}`,
          amount: 7500,
          currency: "usd",
          customer: `cus_dbg_${randomUUID()}`,
          last_payment_error: { code: "card_declined", message: "x" },
        },
      },
    });
    try {
      const out = await processInboundWebhook(
        {
          db: app.db,
          repos: app.repos,
          eventBus: (app as any).eventBus,
          logger: app.log,
          stripeWebhookSecret: stripeSecret,
        },
        {
          provider: "STRIPE",
          rawBody: payload,
          headers: {
            "stripe-signature": createStripeSignature(payload, stripeSecret),
          } as any,
          queryTenantId: testTenantId,
        },
      );
      console.log("SERVICE OK:", JSON.stringify(out));
    } catch (err: any) {
      console.log("SERVICE THREW:", err?.constructor?.name, err?.message?.slice(0, 300));
      const cause: any = err?.cause ?? err?.cause_;
      console.log("CAUSE:", cause?.code, "|", cause?.message ?? cause?.detail ?? "(no cause)");
      console.log("STACK:", String(err?.stack).split("\n").slice(1, 6).join("\n"));
    }
    expect(true).toBe(true);
  });
});
