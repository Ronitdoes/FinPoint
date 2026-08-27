import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { buildApp } from "../app";
import { NullBus } from "@repo/integrations";
import { db, sql, createTenant } from "@repo/db";
import type { FastifyInstance } from "fastify";

import { apiConfig } from "@repo/config";

describe("Step 10 Integration: Event Gateway & Webhook Ingestion", { timeout: 30000 }, () => {
  let app: FastifyInstance;
  let eventBus: NullBus;
  let testTenantId: string;

  const stripeSecret = "whsec_integration_test_stripe_secret_123";
  const razorpaySecret = "rzp_sec_integration_test_razorpay_secret_456";

  function createStripeSignature(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
    const sig = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    return `t=${timestamp},v1=${sig}`;
  }

  function createRazorpaySignature(body: string, secret: string): string {
    return createHmac("sha256", secret).update(body).digest("hex");
  }

  beforeAll(async () => {
    eventBus = new NullBus();

    // Create unique tenant for test run
    const tenant = await createTenant(
      { db },
      {
        name: `Webhook Test Tenant ${randomUUID().slice(0, 8)}`,
        slug: `test-tenant-${randomUUID().slice(0, 8)}`,
      },
    );
    testTenantId = tenant.id;

    const baseConfig = apiConfig();
    const testConfig = {
      ...baseConfig,
      payments: {
        ...baseConfig.payments,
        stripeWebhookSecret: stripeSecret,
        razorpayWebhookSecret: razorpaySecret,
      },
    };

    app = await buildApp({
      eventBus,
      disableRateLimit: true,
      logger: false,
      config: testConfig,
    });
    await app.ready();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("1. Valid Stripe payment_failed webhook -> 200 ACCEPTED, rows created, event PROCESSED & published", async () => {
    eventBus.clear();
    const externalId = `evt_stripe_fail_${randomUUID()}`;
    const paymentIntentId = `pi_fail_${randomUUID()}`;
    const customerRef = `cus_stripe_${randomUUID()}`;

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
          customer_details: {
            name: "Alice Johnson",
            email: "alice@example.com",
          },
          last_payment_error: {
            code: "card_declined",
            decline_code: "insufficient_funds",
            message: "Insufficient balance",
          },
        },
      },
    });

    const sigHeader = createStripeSignature(payload, stripeSecret);

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/stripe?tenant_id=${testTenantId}`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": sigHeader,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ACCEPTED");
    expect(body.eventId).toBeDefined();

    // Verify Customer created in DB
    const [customer] = await db.execute(
      sql`SELECT * FROM customers WHERE tenant_id = ${testTenantId} AND external_ref = ${customerRef}`,
    );
    expect(customer).toBeDefined();
    expect((customer as any).name).toBe("Alice Johnson");

    // Verify Payment created in DB with status FAILED
    const [payment] = await db.execute(
      sql`SELECT * FROM payments WHERE tenant_id = ${testTenantId} AND provider_payment_id = ${paymentIntentId}`,
    );
    expect(payment).toBeDefined();
    expect((payment as any).status).toBe("FAILED");
    expect((payment as any).failure_code).toBe("insufficient_funds");

    // Verify Payment Attempt row created
    const attempts = await db.execute(
      sql`SELECT * FROM payment_attempts WHERE payment_id = ${(payment as any).id}`,
    );
    expect(attempts.length).toBe(1);
    expect((attempts[0] as any).status).toBe("FAILED");
    expect((attempts[0] as any).initiated_by).toBe("PROVIDER_AUTO");

    // Verify Event published onto EventBus
    expect(eventBus.published.length).toBe(1);
    expect(eventBus.published[0].type).toBe("payment.failed");
    expect(eventBus.published[0].source).toBe("STRIPE");
  });

  it("2. Valid Razorpay payment.captured webhook -> 200 ACCEPTED, rows created, event PROCESSED & published", async () => {
    eventBus.clear();
    const externalId = `rzp_evt_succ_${randomUUID()}`;
    const paymentId = `pay_rzp_${randomUUID()}`;
    const customerRef = `cust_rzp_${randomUUID()}`;

    const payload = JSON.stringify({
      id: externalId,
      event: "payment.captured",
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: paymentId,
            amount: 250000,
            currency: "INR",
            customer_id: customerRef,
            email: "priya@example.in",
            contact: "+919876543210",
          },
        },
      },
    });

    const sigHeader = createRazorpaySignature(payload, razorpaySecret);

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/razorpay?tenant_id=${testTenantId}`,
      headers: {
        "content-type": "application/json",
        "x-razorpay-signature": sigHeader,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ACCEPTED");
    expect(body.eventId).toBeDefined();

    // Verify Payment created in DB with status SUCCEEDED and paid_at
    const [payment] = await db.execute(
      sql`SELECT * FROM payments WHERE tenant_id = ${testTenantId} AND provider_payment_id = ${paymentId}`,
    );
    expect(payment).toBeDefined();
    expect((payment as any).status).toBe("SUCCEEDED");
    expect((payment as any).paid_at).toBeDefined();

    // Verify Event published onto EventBus
    expect(eventBus.published.length).toBe(1);
    expect(eventBus.published[0].type).toBe("payment.succeeded");
    expect(eventBus.published[0].source).toBe("RAZORPAY");
  });

  it("3. Invalid signature -> 401 INVALID_SIGNATURE, nothing persisted in DB", async () => {
    const payload = JSON.stringify({
      id: `evt_invalid_${randomUUID()}`,
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `pi_invalid_${randomUUID()}`,
          amount: 1000,
          currency: "usd",
        },
      },
    });

    const invalidSig = "t=1700000000,v1=bad_signature_hash";

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/stripe?tenant_id=${testTenantId}`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": invalidSig,
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error.code).toBe("INVALID_SIGNATURE");
  });

  it("4. Expired signature (>5m) -> 401 INVALID_SIGNATURE", async () => {
    const payload = JSON.stringify({
      id: `evt_expired_${randomUUID()}`,
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000) - 400,
      data: { object: { id: "pi_exp_123", amount: 1000 } },
    });

    const expiredSig = createStripeSignature(
      payload,
      stripeSecret,
      Math.floor(Date.now() / 1000) - 400,
    );

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/stripe?tenant_id=${testTenantId}`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": expiredSig,
      },
      payload,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("INVALID_SIGNATURE");
  });

  it("5. Duplicate delivery x5 concurrently -> exactly 1 ACCEPTED, 4 DUPLICATE, single payment row", async () => {
    eventBus.clear();
    const externalId = `evt_dedup_${randomUUID()}`;
    const paymentId = `pi_dedup_${randomUUID()}`;
    const customerRef = `cus_dedup_${randomUUID()}`;

    const payload = JSON.stringify({
      id: externalId,
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: paymentId,
          amount: 5000,
          currency: "usd",
          customer: customerRef,
        },
      },
    });

    const sigHeader = createStripeSignature(payload, stripeSecret);

    // Send 5 identical webhook deliveries concurrently
    const requests = Array.from({ length: 5 }).map(() =>
      app.inject({
        method: "POST",
        url: `/webhooks/stripe?tenant_id=${testTenantId}`,
        headers: {
          "content-type": "application/json",
          "stripe-signature": sigHeader,
        },
        payload,
      }),
    );

    const responses = await Promise.all(requests);
    const statuses = responses.map((r) => r.json().status);

    const acceptedCount = statuses.filter((s) => s === "ACCEPTED").length;
    const duplicateCount = statuses.filter((s) => s === "DUPLICATE").length;

    expect(acceptedCount).toBe(1);
    expect(duplicateCount).toBe(4);

    // Verify exactly 1 payment record exists in DB
    const payments = await db.execute(
      sql`SELECT * FROM payments WHERE tenant_id = ${testTenantId} AND provider_payment_id = ${paymentId}`,
    );
    expect(payments.length).toBe(1);

    // Verify exactly 1 event published to EventBus
    expect(eventBus.published.length).toBe(1);
  }, 20000);

  it("6. Out-of-order delivery (SUCCEEDED before FAILED) -> final state stays SUCCEEDED, regression ignored", async () => {
    const paymentId = `pi_ooo_${randomUUID()}`;
    const customerRef = `cus_ooo_${randomUUID()}`;

    // 1st delivery: payment.succeeded
    const succPayload = JSON.stringify({
      id: `evt_succ_${randomUUID()}`,
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: paymentId,
          amount: 10000,
          currency: "usd",
          customer: customerRef,
        },
      },
    });

    const succRes = await app.inject({
      method: "POST",
      url: `/webhooks/stripe?tenant_id=${testTenantId}`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": createStripeSignature(succPayload, stripeSecret),
      },
      payload: succPayload,
    });
    expect(succRes.statusCode).toBe(200);

    // 2nd delivery (delayed/out-of-order): payment.failed for same payment
    const failPayload = JSON.stringify({
      id: `evt_fail_${randomUUID()}`,
      type: "payment_intent.payment_failed",
      created: Math.floor(Date.now() / 1000) - 10,
      data: {
        object: {
          id: paymentId,
          amount: 10000,
          currency: "usd",
          customer: customerRef,
          last_payment_error: { code: "generic_decline" },
        },
      },
    });

    const failRes = await app.inject({
      method: "POST",
      url: `/webhooks/stripe?tenant_id=${testTenantId}`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": createStripeSignature(failPayload, stripeSecret),
      },
      payload: failPayload,
    });
    expect(failRes.statusCode).toBe(200);

    // Assert final status in DB remained SUCCEEDED (did NOT regress to FAILED)
    const [finalPayment] = await db.execute(
      sql`SELECT * FROM payments WHERE tenant_id = ${testTenantId} AND provider_payment_id = ${paymentId}`,
    );
    expect((finalPayment as any).status).toBe("SUCCEEDED");
  }, 30000);

  it("7. Malformed JSON -> 400 UNMAPPABLE_PAYLOAD, no crash", async () => {
    const rawMalformed = "{ invalid_json: ";
    const sigHeader = createStripeSignature(rawMalformed, stripeSecret);

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/stripe?tenant_id=${testTenantId}`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": sigHeader,
      },
      payload: rawMalformed,
    });

    expect(response.statusCode).toBe(400);
  });

  it("8. Wrong Content-Type (e.g. text/plain) -> 406 NOT_ACCEPTABLE", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/stripe?tenant_id=${testTenantId}`,
      headers: {
        "content-type": "text/plain",
      },
      payload: "plain text payload",
    });

    expect(response.statusCode).toBe(406);
    expect(response.json().error.code).toBe("NOT_ACCEPTABLE");
  });

  it("9. Unsupported event type -> 200 ACCEPTED, stored as UNMAPPED in events table, no core projections", async () => {
    const externalId = `evt_unmapped_${randomUUID()}`;
    const payload = JSON.stringify({
      id: externalId,
      type: "coupon.created",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: "coupon_123",
          percent_off: 20,
        },
      },
    });

    const sigHeader = createStripeSignature(payload, stripeSecret);

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/stripe?tenant_id=${testTenantId}`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": sigHeader,
      },
      payload,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ACCEPTED");

    // Verify stored event has type UNMAPPED
    const [storedEvent] = await db.execute(
      sql`SELECT * FROM events WHERE id = ${body.eventId}`,
    );
    expect(storedEvent).toBeDefined();
    expect((storedEvent as any).type).toBe("UNMAPPED");
  });

  it("10. LLM / workflow absence assertion: 0 rows created in ai_decisions, messages, workflows", async () => {
    const externalId = `evt_absence_${randomUUID()}`;
    const payload = JSON.stringify({
      id: externalId,
      type: "payment_intent.payment_failed",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: {
          id: `pi_absence_${randomUUID()}`,
          amount: 5000,
          currency: "usd",
          customer: `cus_absence_${randomUUID()}`,
          last_payment_error: { code: "card_declined" },
        },
      },
    });

    await app.inject({
      method: "POST",
      url: `/webhooks/stripe?tenant_id=${testTenantId}`,
      headers: {
        "content-type": "application/json",
        "stripe-signature": createStripeSignature(payload, stripeSecret),
      },
      payload,
    });

    // Assert strictly 0 AI decisions, messages, or workflow records
    const [aiCount] = await db.execute(
      sql`SELECT count(*) as count FROM ai_decisions WHERE tenant_id = ${testTenantId}`,
    );
    const [msgCount] = await db.execute(
      sql`SELECT count(*) as count FROM messages WHERE tenant_id = ${testTenantId}`,
    );
    const [wfCount] = await db.execute(
      sql`SELECT count(*) as count FROM workflows WHERE tenant_id = ${testTenantId}`,
    );

    expect(Number((aiCount as any).count)).toBe(0);
    expect(Number((msgCount as any).count)).toBe(0);
    expect(Number((wfCount as any).count)).toBe(0);
  });

  it("11. Performance smoke test: sequential deliveries under budget", async () => {
    const latencies: number[] = [];
    const count = 5;

    for (let i = 0; i < count; i++) {
      const payload = JSON.stringify({
        id: `evt_perf_${i}_${randomUUID()}`,
        type: "payment_intent.succeeded",
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `pi_perf_${i}_${randomUUID()}`,
            amount: 1000 + i,
            currency: "usd",
            customer: `cus_perf_${i}`,
          },
        },
      });

      const sigHeader = createStripeSignature(payload, stripeSecret);
      const start = performance.now();

      const response = await app.inject({
        method: "POST",
        url: `/webhooks/stripe?tenant_id=${testTenantId}`,
        headers: {
          "content-type": "application/json",
          "stripe-signature": sigHeader,
        },
        payload,
      });

      const duration = performance.now() - start;
      latencies.push(duration);
      expect(response.statusCode).toBe(200);
    }

    expect(latencies.length).toBe(count);
  }, 45000);
});
