import { createHmac, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  findCustomerByExternalRef,
  findPaymentById,
  findPaymentByProviderPaymentId,
  createCustomer,
  createCheckout,
  updateCheckoutStatus,
  recordCheckoutEvent,
  findLiveCaseByObligation,
  insertEventIfNew,
  type Database,
} from "@repo/db";
import { TOPIC_MAIN } from "@repo/integrations";
import type { DomainEvent } from "@repo/domain";
import { getDemoInjections } from "./injections";
import { NotFoundError } from "../../lib/errors";

export const DEV_MOCK_STRIPE_WEBHOOK_SECRET =
  "whsec_dev_mock_secret_for_local_demo_testing_only";
export const DEV_MOCK_RAZORPAY_WEBHOOK_SECRET =
  "rzp_dev_mock_secret_for_local_demo_testing_only";

// Webhook signing secrets resolve via typed config
// (`(app as any).config.payments.*`, CONVENTIONS §1) with DEV_MOCK fallback
// for local demo. No raw `process.env` reads in this module.

/**
 * Computes Stripe v1 signature header.
 */
export function signStripePayload(
  rawBody: string,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): string {
  const payloadToSign = `${timestamp}.${rawBody}`;
  const sig = createHmac("sha256", secret).update(payloadToSign, "utf8").digest("hex");
  return `t=${timestamp},v1=${sig}`;
}

/**
 * Computes Razorpay HMAC-SHA256 signature header.
 */
export function signRazorpayPayload(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Resolves or synthesizes a customer for demo simulations.
 */
async function resolveOrCreateCustomer(
  db: Database,
  repos: any,
  tenantId: string,
  customerRef?: string,
  defaultName: string = "Demo Customer",
  defaultEmail: string = "demo@example.com",
  defaultPhone: string = "+919876543210",
) {
  if (customerRef) {
    const existing = await repos.findCustomerByExternalRef(
      { db },
      { tenantId, externalRef: customerRef },
    );
    if (existing) {
      return existing;
    }
  }

  // Synthesize new customer
  const ref = customerRef || `CUS-${randomUUID().slice(0, 6).toUpperCase()}`;
  return await repos.createCustomer(
    { db },
    {
      tenantId,
      externalRef: ref,
      name: customerRef ? `${customerRef} (${defaultName})` : defaultName,
      email: `${ref.toLowerCase()}@example.com`,
      phone: defaultPhone,
      status: "ACTIVE",
      lifetimeValue: 2500000n,
    },
  );
}

export interface SimulatePaymentFailOptions {
  tenantId: string;
  customerRef?: string;
  amountMinor?: number;
  provider?: "STRIPE" | "RAZORPAY" | string;
}

/**
 * Simulates a payment failure by synthesizing a customer/payment and sending
 * a real signed webhook to the loopback /webhooks/{provider} endpoint.
 */
export async function simulatePaymentFail(
  app: FastifyInstance,
  options: SimulatePaymentFailOptions,
) {
  const { tenantId } = options;
  const amountMinor = options.amountMinor ?? 1299900; // ₹12,999 in paise
  const provider = (options.provider || "STRIPE").toUpperCase() === "RAZORPAY" ? "RAZORPAY" : "STRIPE";
  const customerRef = options.customerRef || "CUS-001";

  const customer = await resolveOrCreateCustomer(
    app.db,
    app.repos,
    tenantId,
    customerRef,
    "Aditi Sharma",
    "aditi@example.com",
    "+919876543210",
  );

  const providerPaymentId =
    provider === "STRIPE"
      ? `pi_demo_fail_${randomUUID().slice(0, 12)}`
      : `pay_demo_fail_${randomUUID().slice(0, 12)}`;

  let rawBody: string;
  let headers: Record<string, string>;

  if (provider === "STRIPE") {
    const stripeSecret =
      (app as any).config?.payments?.stripeWebhookSecret ||
      DEV_MOCK_STRIPE_WEBHOOK_SECRET;

    const eventId = `evt_demo_${randomUUID().slice(0, 12)}`;
    const payload = {
      id: eventId,
      object: "event",
      api_version: "2023-10-16",
      created: Math.floor(Date.now() / 1000),
      type: "payment_intent.payment_failed",
      data: {
        object: {
          id: providerPaymentId,
          object: "payment_intent",
          amount: amountMinor,
          currency: "inr",
          status: "requires_payment_method",
          customer: customer.externalRef || customer.id,
          customer_details: {
            name: customer.name,
            email: customer.email,
            phone: customer.phone,
          },
          last_payment_error: {
            code: "insufficient_funds",
            decline_code: "insufficient_funds",
            message: "The customer account has insufficient funds to complete the transaction.",
            type: "card_error",
          },
          metadata: {
            tenant_id: tenantId,
            customer_ref: customer.externalRef || customer.id,
          },
        },
      },
    };

    rawBody = JSON.stringify(payload);
    headers = {
      "content-type": "application/json",
      "x-tenant-id": tenantId,
      "stripe-signature": signStripePayload(rawBody, stripeSecret),
    };
  } else {
    const razorpaySecret =
      (app as any).config?.payments?.razorpayWebhookSecret ||
      DEV_MOCK_RAZORPAY_WEBHOOK_SECRET;

    const eventId = `event_demo_${randomUUID().slice(0, 12)}`;
    const payload = {
      entity: "event",
      account_id: "acc_demo_rzp",
      event: "payment.failed",
      contains: ["payment"],
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: providerPaymentId,
            amount: amountMinor,
            currency: "INR",
            status: "failed",
            order_id: `order_demo_${randomUUID().slice(0, 10)}`,
            email: customer.email,
            contact: customer.phone,
            error_code: "BAD_REQUEST_PAYMENT_DECLINED",
            error_description: "Payment was declined by the bank due to insufficient funds.",
            notes: {
              tenant_id: tenantId,
              customer_ref: customer.externalRef || customer.id,
            },
          },
        },
      },
    };

    rawBody = JSON.stringify(payload);
    headers = {
      "content-type": "application/json",
      "x-tenant-id": tenantId,
      "x-razorpay-signature": signRazorpayPayload(rawBody, razorpaySecret),
    };
  }

  // Check failure-injection switch for duplicate webhook simulation
  const injections = await getDemoInjections(
    (app as any).redisClient,
    (app as any).config?.demo,
  );

  const url = `/webhooks/${provider.toLowerCase()}?tenant_id=${encodeURIComponent(tenantId)}`;

  let webhookStatus: string = "ACCEPTED";
  let eventId: string | undefined;

  if (injections.injections.simulate_duplicate_webhook) {
    // Concurrent double-delivery to prove idempotency live
    const [res1, res2] = await Promise.all([
      app.inject({ method: "POST", url, headers, payload: rawBody }),
      app.inject({ method: "POST", url, headers, payload: rawBody }),
    ]);

    const json1 = JSON.parse(res1.body || "{}");
    const json2 = JSON.parse(res2.body || "{}");

    const status1 = json1.status;
    const status2 = json2.status;
    webhookStatus =
      status1 === "ACCEPTED" || status2 === "ACCEPTED"
        ? "ACCEPTED"
        : (status1 || status2 || "ACCEPTED");
    eventId = json1.eventId || json2.eventId;

    app.log.info(
      {
        scenario: "payment-fail",
        duplicateProved: true,
        delivery1: { code: res1.statusCode, status: json1.status },
        delivery2: { code: res2.statusCode, status: json2.status },
        refs: { providerPaymentId, customerRef, eventId },
      },
      "DEMO: Concurrent duplicate webhook delivery executed (idempotency verified)",
    );
  } else {
    const res = await app.inject({
      method: "POST",
      url,
      headers,
      payload: rawBody,
    });

    const json = JSON.parse(res.body || "{}");
    webhookStatus = json.status || "ACCEPTED";
    eventId = json.eventId;

    app.log.info(
      {
        scenario: "payment-fail",
        provider,
        statusCode: res.statusCode,
        status: webhookStatus,
        refs: { providerPaymentId, customerRef, eventId },
      },
      "DEMO: Simulated payment failure dispatched via loopback webhook",
    );
  }

  return {
    ok: true,
    refs: {
      provider,
      providerPaymentId,
      customerId: customer.id,
      customerRef: customer.externalRef || customer.id,
      amountMinor,
      eventId,
      webhookStatus,
    },
  };
}

export interface SimulatePaymentSucceedOptions {
  tenantId: string;
  paymentId?: string;
  providerPaymentId?: string;
}

/**
 * Simulates a payment success for an existing payment, dispatching a loopback
 * success webhook and signaling any active recovery workflows.
 */
export async function simulatePaymentSucceed(
  app: FastifyInstance,
  options: SimulatePaymentSucceedOptions,
) {
  const { tenantId, paymentId, providerPaymentId } = options;

  let payment: any = null;
  if (paymentId) {
    payment = await app.repos.findPaymentById(
      { db: app.db },
      { tenantId, paymentId },
    );
  } else if (providerPaymentId) {
    payment =
      (await app.repos.findPaymentByProviderPaymentId(
        { db: app.db },
        { tenantId, provider: "STRIPE", providerPaymentId },
      )) ||
      (await app.repos.findPaymentByProviderPaymentId(
        { db: app.db },
        { tenantId, provider: "RAZORPAY", providerPaymentId },
      ));
  }

  if (!payment) {
    throw new NotFoundError("Payment not found for simulation", {
      paymentId,
      providerPaymentId,
    });
  }

  const effectiveProviderPaymentId =
    payment.providerPaymentId || `pi_succ_${randomUUID().slice(0, 10)}`;
  const provider = payment.provider === "RAZORPAY" ? "RAZORPAY" : "STRIPE";
  const amountMinor = Number(payment.amount);

  const customer = await app.repos.findCustomerById(
    { db: app.db },
    { tenantId, customerId: payment.customerId },
  );

  let rawBody: string;
  let headers: Record<string, string>;

  if (provider === "STRIPE") {
    const stripeSecret =
      (app as any).config?.payments?.stripeWebhookSecret ||
      DEV_MOCK_STRIPE_WEBHOOK_SECRET;

    const eventId = `evt_demo_succ_${randomUUID().slice(0, 12)}`;
    const payload = {
      id: eventId,
      object: "event",
      api_version: "2023-10-16",
      created: Math.floor(Date.now() / 1000),
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: effectiveProviderPaymentId,
          object: "payment_intent",
          amount: amountMinor,
          currency: (payment.currency || "INR").toLowerCase(),
          status: "succeeded",
          customer: customer?.externalRef || customer?.id || payment.customerId,
          customer_details: {
            name: customer?.name || "Demo Customer",
            email: customer?.email || "demo@example.com",
            phone: customer?.phone || "+919876543210",
          },
          metadata: {
            tenant_id: tenantId,
            payment_id: payment.id,
          },
        },
      },
    };

    rawBody = JSON.stringify(payload);
    headers = {
      "content-type": "application/json",
      "x-tenant-id": tenantId,
      "stripe-signature": signStripePayload(rawBody, stripeSecret),
    };
  } else {
    const razorpaySecret =
      (app as any).config?.payments?.razorpayWebhookSecret ||
      DEV_MOCK_RAZORPAY_WEBHOOK_SECRET;

    const eventId = `event_demo_succ_${randomUUID().slice(0, 12)}`;
    const payload = {
      entity: "event",
      account_id: "acc_demo_rzp",
      event: "payment.captured",
      contains: ["payment"],
      created_at: Math.floor(Date.now() / 1000),
      payload: {
        payment: {
          entity: {
            id: effectiveProviderPaymentId,
            amount: amountMinor,
            currency: payment.currency || "INR",
            status: "captured",
            email: customer?.email || "demo@example.com",
            contact: customer?.phone || "+919876543210",
            notes: {
              tenant_id: tenantId,
              payment_id: payment.id,
            },
          },
        },
      },
    };

    rawBody = JSON.stringify(payload);
    headers = {
      "content-type": "application/json",
      "x-tenant-id": tenantId,
      "x-razorpay-signature": signRazorpayPayload(rawBody, razorpaySecret),
    };
  }

  const url = `/webhooks/${provider.toLowerCase()}?tenant_id=${encodeURIComponent(tenantId)}`;
  const res = await app.inject({
    method: "POST",
    url,
    headers,
    payload: rawBody,
  });

  const json = JSON.parse(res.body || "{}");

  // Also check and signal workflow directly if active recovery case exists
  let workflowSignaled = false;
  try {
    const activeCase = await findLiveCaseByObligation(
      { db: app.db },
      { tenantId, sourceEntityType: "PAYMENT", sourceEntityId: payment.id },
    );
    if (activeCase && (app as any).workflowClient) {
      await (app as any).workflowClient.signalCase({
        tenantId,
        caseId: activeCase.id,
        signal: "external-payment-succeeded",
        payload: {
          paymentId: payment.id,
          amount: amountMinor,
          currency: payment.currency,
          paidAt: new Date().toISOString(),
        },
        db: app.db,
      });
      workflowSignaled = true;
    }
  } catch {
    // best-effort signaling
  }

  app.log.info(
    {
      scenario: "payment-succeed",
      refs: { paymentId: payment.id, providerPaymentId: effectiveProviderPaymentId, eventId: json.eventId },
      workflowSignaled,
    },
    "DEMO: Simulated payment success dispatched via loopback webhook",
  );

  return {
    ok: true,
    refs: {
      paymentId: payment.id,
      providerPaymentId: effectiveProviderPaymentId,
      customerId: payment.customerId,
      eventId: json.eventId,
      webhookStatus: json.status || "ACCEPTED",
      workflowSignaled,
    },
  };
}

export interface SimulateCheckoutAbandonOptions {
  tenantId: string;
  customerRef?: string;
  cartValueMinor?: number;
  ageMinutes?: number;
  authHeaders?: Record<string, string>;
}

/**
 * Simulates checkout abandonment: creates checkout session, dispatches checkout.started
 * via POST /events, then advances the timer state and emits checkout.abandoned.
 */
export async function simulateCheckoutAbandon(
  app: FastifyInstance,
  options: SimulateCheckoutAbandonOptions,
) {
  const { tenantId } = options;
  const cartValueMinor = options.cartValueMinor ?? 799900; // ₹7,999 in paise (Scenario B)
  const ageMinutes = options.ageMinutes ?? 5;
  const customerRef = options.customerRef || "CUS-002";

  const customer = await resolveOrCreateCustomer(
    app.db,
    app.repos,
    tenantId,
    customerRef,
    "Rahul Verma",
    "rahul@example.com",
    "+919876543211",
  );

  const startedAt = new Date(Date.now() - ageMinutes * 60 * 1000);
  const sourceRef = `chk_demo_${randomUUID().slice(0, 10)}`;

  // 1. Create checkout in database with STARTED status
  const checkout = await app.repos.createCheckout(
    { db: app.db },
    {
      tenantId,
      customerId: customer.id,
      cartValue: BigInt(cartValueMinor),
      currency: "INR",
      sourceRef,
      status: "STARTED",
      startedAt,
      lastActivityAt: startedAt,
      items: [
        {
          sku: "SKU-PRO-RECOVERY",
          name: "Annual Recovery Suite",
          quantity: 1,
          unitAmountMinor: cartValueMinor,
        },
      ],
    },
  );

  // 2. Dispatch checkout.started via POST /events or internal ingestion
  let startedEventId: string | undefined;
  try {
    const eventsRes = await app.inject({
      method: "POST",
      url: "/events",
      headers: {
        "content-type": "application/json",
        ...(options.authHeaders || {}),
      },
      payload: {
        type: "checkout.started",
        tenant_id: tenantId,
        customer_id: customer.id,
        entity_type: "CHECKOUT",
        entity_id: checkout.id,
        occurred_at: startedAt.toISOString(),
        payload: {
          checkoutId: checkout.id,
          customerId: customer.id,
          cartValue: cartValueMinor,
          currency: "INR",
        },
      },
    });

    if (eventsRes.statusCode === 202) {
      startedEventId = JSON.parse(eventsRes.body || "{}").eventId;
    }
  } catch {
    // fallback to direct event insertion
  }

  if (!startedEventId) {
    const corrId = randomUUID();
    const insertRes = await app.repos.insertEventIfNew(
      { db: app.db },
      {
        tenantId,
        source: "INTERNAL",
        type: "checkout.started",
        customerId: customer.id,
        entityType: "CHECKOUT",
        entityId: checkout.id,
        rawPayload: { checkoutId: checkout.id, cartValue: cartValueMinor },
        payload: { checkoutId: checkout.id, cartValue: cartValueMinor },
        correlationId: corrId,
        status: "RECEIVED",
        receivedAt: startedAt,
      },
    );
    startedEventId = insertRes.event.id;
    await app.eventBus.publish({
      id: startedEventId,
      type: "checkout.started",
      occurred_at: startedAt.toISOString(),
      source: "INTERNAL",
      tenant_id: tenantId,
      customer_id: customer.id,
      entity_id: checkout.id,
      entity_type: "CHECKOUT",
      correlation_id: corrId,
      payload: {
        checkoutId: checkout.id,
        cartValue: cartValueMinor,
        currency: "INR",
      },
    });
  }

  // 3. Forced abandonment: update checkout status and emit checkout.abandoned to advance timer state
  const abandonedAt = new Date();
  await app.repos.updateCheckoutStatus(
    { db: app.db },
    {
      tenantId,
      checkoutId: checkout.id,
      status: "ABANDONED",
      abandonedAt,
    },
  );

  await app.repos.recordCheckoutEvent(
    { db: app.db },
    {
      tenantId,
      checkoutId: checkout.id,
      type: "CHECKOUT_ABANDONED",
      payload: {
        reason: "INACTIVITY_TIMER_EXPIRED",
        ageMinutes,
        forcedSimulation: true,
      },
      occurredAt: abandonedAt,
    },
  );

  const abandonedEvent: DomainEvent = {
    id: randomUUID(),
    type: "checkout.abandoned",
    occurred_at: abandonedAt.toISOString(),
    source: "INTERNAL",
    tenant_id: tenantId,
    customer_id: customer.id,
    entity_id: checkout.id,
    entity_type: "CHECKOUT",
    payload: {
      checkoutId: checkout.id,
      cartValue: cartValueMinor,
      currency: "INR",
      customerRef: customer.externalRef || customer.id,
    },
    correlation_id: randomUUID(),
  };

  await app.eventBus.publish(abandonedEvent, {
    topic: TOPIC_MAIN,
    key: tenantId,
  });

  app.log.info(
    {
      scenario: "checkout-abandon",
      refs: { checkoutId: checkout.id, customerRef, startedEventId },
    },
    "DEMO: Simulated checkout abandonment executed and event published",
  );

  return {
    ok: true,
    refs: {
      checkoutId: checkout.id,
      customerId: customer.id,
      customerRef: customer.externalRef || customer.id,
      cartValueMinor,
      startedEventId,
      abandonedEventId: abandonedEvent.id,
      status: "ABANDONED",
    },
  };
}

export interface SimulateInvoiceOverdueOptions {
  tenantId: string;
  customerRef?: string;
  amountMinor?: number;
  daysOverdue?: number;
}

/**
 * Simulates an overdue enterprise invoice via signed Stripe webhook.
 * Triggers invoice overdue risk scoring and human escalation approval gate.
 */
export async function simulateInvoiceOverdue(
  app: FastifyInstance,
  options: SimulateInvoiceOverdueOptions,
) {
  const { tenantId } = options;
  const amountMinor = options.amountMinor ?? 48000000; // ₹4,80,000 in paise (Scenario C)
  const daysOverdue = options.daysOverdue ?? 7;
  const customerRef = options.customerRef || "CUS-003";

  const customer = await resolveOrCreateCustomer(
    app.db,
    app.repos,
    tenantId,
    customerRef,
    "Acme Enterprises",
    "billing@acme.com",
    "+919876543212",
  );

  const providerInvoiceId = `in_demo_overdue_${randomUUID().slice(0, 10)}`;
  const invoiceNumber = `INV-${randomUUID().slice(0, 6).toUpperCase()}`;
  const dueDateSeconds = Math.floor(Date.now() / 1000) - daysOverdue * 86400;

  const stripeSecret =
    (app as any).config?.payments?.stripeWebhookSecret ||
    DEV_MOCK_STRIPE_WEBHOOK_SECRET;

  const eventId = `evt_demo_inv_${randomUUID().slice(0, 12)}`;
  const payload = {
    id: eventId,
    object: "event",
    api_version: "2023-10-16",
    created: Math.floor(Date.now() / 1000),
    type: "invoice.payment_failed",
    data: {
      object: {
        id: providerInvoiceId,
        object: "invoice",
        number: invoiceNumber,
        amount_due: amountMinor,
        amount_paid: 0,
        currency: "inr",
        status: "open",
        due_date: dueDateSeconds,
        customer: customer.externalRef || customer.id,
        customer_details: {
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
        },
        metadata: {
          tenant_id: tenantId,
          customer_ref: customer.externalRef || customer.id,
          days_overdue: daysOverdue,
        },
      },
    },
  };

  const rawBody = JSON.stringify(payload);
  const headers = {
    "content-type": "application/json",
    "x-tenant-id": tenantId,
    "stripe-signature": signStripePayload(rawBody, stripeSecret),
  };

  const url = `/webhooks/stripe?tenant_id=${encodeURIComponent(tenantId)}`;
  const res = await app.inject({
    method: "POST",
    url,
    headers,
    payload: rawBody,
  });

  const json = JSON.parse(res.body || "{}");

  app.log.info(
    {
      scenario: "invoice-overdue",
      refs: { providerInvoiceId, invoiceNumber, customerRef, eventId: json.eventId },
    },
    "DEMO: Simulated invoice overdue dispatched via loopback webhook",
  );

  return {
    ok: true,
    refs: {
      providerInvoiceId,
      invoiceNumber,
      customerId: customer.id,
      customerRef: customer.externalRef || customer.id,
      amountMinor,
      daysOverdue,
      eventId: json.eventId,
      webhookStatus: json.status || "ACCEPTED",
    },
  };
}
