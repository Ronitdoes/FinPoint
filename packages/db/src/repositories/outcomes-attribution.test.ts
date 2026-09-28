import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { db, healthCheck } from "../client";
import { createTenant } from "./tenants.repo";
import { createCustomer } from "./customers.repo";
import { createPayment } from "./payments.repo";
import { createInvoice } from "./invoices.repo";
import { createCheckout } from "./checkouts.repo";
import { createCase } from "./cases.repo";
import { createSubscription } from "./subscriptions.repo";
import { findMatchingPaymentForAttribution } from "./outcomes.repo";

/**
 * P1 regression: INVOICE/CHECKOUT attribution must require an explicit
 * obligation link. Same-customer unrelated SUCCEEDED payments must NOT
 * attribute (return null). PAYMENT/SUBSCRIPTION paths stay unchanged.
 */
describe("outcomes attribution — strict INVOICE/CHECKOUT obligation link", () => {
  beforeAll(async () => {
    const healthy = await healthCheck();
    expect(healthy).toBe(true);
  });

  it("INVOICE: same-customer unrelated payment => no attribution (null)", async () => {
    const tenant = await createTenant(
      { db },
      {
        name: `attr-neg-inv ${randomUUID()}`,
        slug: `attr-neg-inv-${randomUUID().slice(0, 8)}`,
      },
    );
    const customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        externalRef: `cust_${randomUUID()}`,
        name: "Attr Neg Customer",
        email: `attr-neg-${randomUUID().slice(0, 8)}@example.com`,
      },
    );
    const invoice = await createInvoice(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        number: `INV-NEG-${randomUUID().slice(0, 8)}`,
        amount: 100000n,
        currency: "INR",
        status: "OVERDUE",
        dueAt: new Date(Date.now() - 24 * 3600 * 1000),
      },
    );
    const openedAt = new Date(Date.now() - 24 * 3600 * 1000);
    const caseRecord = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        riskType: "INVOICE_OVERDUE",
        sourceEntityType: "INVOICE",
        sourceEntityId: invoice.id,
        amountAtRisk: 100000n,
        currency: "INR",
        riskScore: 60,
        status: "STOPPED",
        attributionWindowHours: 72,
        openedAt,
      },
    );
    // Unrelated same-customer SUCCEEDED payment inside the window, with no
    // invoice linkage in methodMetadata and no provider-reference match.
    await createPayment(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        amount: 100000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "STRIPE",
        providerPaymentId: `pi_unrelated_${randomUUID()}`,
        methodMetadata: { brand: "visa" },
        occurredAt: new Date(),
      },
    );

    const match = await findMatchingPaymentForAttribution(
      { db },
      { tenantId: tenant.id, caseRecord },
    );
    expect(match).toBeNull();
  });

  it("INVOICE: linked payment via methodMetadata invoice_id => attributed", async () => {
    const tenant = await createTenant(
      { db },
      {
        name: `attr-pos-inv ${randomUUID()}`,
        slug: `attr-pos-inv-${randomUUID().slice(0, 8)}`,
      },
    );
    const customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        externalRef: `cust_${randomUUID()}`,
        name: "Attr Pos Customer",
        email: `attr-pos-${randomUUID().slice(0, 8)}@example.com`,
      },
    );
    const invoice = await createInvoice(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        number: `INV-POS-${randomUUID().slice(0, 8)}`,
        amount: 75000n,
        currency: "INR",
        status: "OVERDUE",
        dueAt: new Date(Date.now() - 24 * 3600 * 1000),
      },
    );
    const openedAt = new Date(Date.now() - 24 * 3600 * 1000);
    const caseRecord = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        riskType: "INVOICE_OVERDUE",
        sourceEntityType: "INVOICE",
        sourceEntityId: invoice.id,
        amountAtRisk: 75000n,
        currency: "INR",
        riskScore: 60,
        status: "STOPPED",
        attributionWindowHours: 72,
        openedAt,
      },
    );
    const linked = await createPayment(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        amount: 75000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "STRIPE",
        providerPaymentId: `pi_linked_${randomUUID()}`,
        methodMetadata: { invoice_id: invoice.id },
        occurredAt: new Date(),
      },
    );

    const match = await findMatchingPaymentForAttribution(
      { db },
      { tenantId: tenant.id, caseRecord },
    );
    expect(match?.id).toBe(linked.id);
  });

  it("INVOICE: linked payment via provider reference => attributed", async () => {
    const tenant = await createTenant(
      { db },
      {
        name: `attr-prov-inv ${randomUUID()}`,
        slug: `attr-prov-inv-${randomUUID().slice(0, 8)}`,
      },
    );
    const customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        externalRef: `cust_${randomUUID()}`,
        name: "Attr Prov Customer",
        email: `attr-prov-${randomUUID().slice(0, 8)}@example.com`,
      },
    );
    const providerInvoiceId = `in_prov_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const invoice = await createInvoice(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        number: `INV-PROV-${randomUUID().slice(0, 8)}`,
        amount: 50000n,
        currency: "INR",
        status: "OVERDUE",
        dueAt: new Date(Date.now() - 24 * 3600 * 1000),
        provider: "STRIPE",
        providerInvoiceId,
      },
    );
    const openedAt = new Date(Date.now() - 24 * 3600 * 1000);
    const caseRecord = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        riskType: "INVOICE_OVERDUE",
        sourceEntityType: "INVOICE",
        sourceEntityId: invoice.id,
        amountAtRisk: 50000n,
        currency: "INR",
        riskScore: 60,
        status: "STOPPED",
        attributionWindowHours: 72,
        openedAt,
      },
    );
    const linked = await createPayment(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        amount: 50000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "STRIPE",
        providerPaymentId: providerInvoiceId,
        occurredAt: new Date(),
      },
    );

    const match = await findMatchingPaymentForAttribution(
      { db },
      { tenantId: tenant.id, caseRecord },
    );
    expect(match?.id).toBe(linked.id);
  });

  it("CHECKOUT: same-customer unrelated payment => no attribution (null)", async () => {
    const tenant = await createTenant(
      { db },
      {
        name: `attr-neg-co ${randomUUID()}`,
        slug: `attr-neg-co-${randomUUID().slice(0, 8)}`,
      },
    );
    const customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        externalRef: `cust_${randomUUID()}`,
        name: "Attr Neg CO Customer",
        email: `attr-neg-co-${randomUUID().slice(0, 8)}@example.com`,
      },
    );
    const checkout = await createCheckout(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        cartValue: 60000n,
        currency: "INR",
        status: "ABANDONED",
        sourceRef: `chk_neg_${randomUUID().slice(0, 8)}`,
        startedAt: new Date(Date.now() - 24 * 3600 * 1000),
        lastActivityAt: new Date(Date.now() - 24 * 3600 * 1000),
      },
    );
    const openedAt = new Date(Date.now() - 24 * 3600 * 1000);
    const caseRecord = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        riskType: "CHECKOUT_ABANDONMENT",
        sourceEntityType: "CHECKOUT",
        sourceEntityId: checkout.id,
        amountAtRisk: 60000n,
        currency: "INR",
        riskScore: 50,
        status: "STOPPED",
        attributionWindowHours: 72,
        openedAt,
      },
    );
    await createPayment(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        amount: 60000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "RAZORPAY",
        providerPaymentId: `pay_unrelated_${randomUUID()}`,
        methodMetadata: { method: "upi" },
        occurredAt: new Date(),
      },
    );

    const match = await findMatchingPaymentForAttribution(
      { db },
      { tenantId: tenant.id, caseRecord },
    );
    expect(match).toBeNull();
  });

  it("CHECKOUT: linked payment via sourceRef metadata => attributed", async () => {
    const tenant = await createTenant(
      { db },
      {
        name: `attr-pos-co ${randomUUID()}`,
        slug: `attr-pos-co-${randomUUID().slice(0, 8)}`,
      },
    );
    const customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        externalRef: `cust_${randomUUID()}`,
        name: "Attr Pos CO Customer",
        email: `attr-pos-co-${randomUUID().slice(0, 8)}@example.com`,
      },
    );
    const sourceRef = `chk_pos_${randomUUID().slice(0, 8)}`;
    const checkout = await createCheckout(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        cartValue: 40000n,
        currency: "INR",
        status: "ABANDONED",
        sourceRef,
        startedAt: new Date(Date.now() - 24 * 3600 * 1000),
        lastActivityAt: new Date(Date.now() - 24 * 3600 * 1000),
      },
    );
    const openedAt = new Date(Date.now() - 24 * 3600 * 1000);
    const caseRecord = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        riskType: "CHECKOUT_ABANDONMENT",
        sourceEntityType: "CHECKOUT",
        sourceEntityId: checkout.id,
        amountAtRisk: 40000n,
        currency: "INR",
        riskScore: 50,
        status: "STOPPED",
        attributionWindowHours: 72,
        openedAt,
      },
    );
    const linked = await createPayment(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        amount: 40000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "RAZORPAY",
        providerPaymentId: `pay_linked_${randomUUID()}`,
        methodMetadata: { source_ref: sourceRef },
        occurredAt: new Date(),
      },
    );

    const match = await findMatchingPaymentForAttribution(
      { db },
      { tenantId: tenant.id, caseRecord },
    );
    expect(match?.id).toBe(linked.id);
  });

  it("PAYMENT path unchanged: source payment still attributes", async () => {
    const tenant = await createTenant(
      { db },
      {
        name: `attr-pay ${randomUUID()}`,
        slug: `attr-pay-${randomUUID().slice(0, 8)}`,
      },
    );
    const customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        externalRef: `cust_${randomUUID()}`,
        name: "Attr Pay Customer",
        email: `attr-pay-${randomUUID().slice(0, 8)}@example.com`,
      },
    );
    const payment = await createPayment(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        amount: 90000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "STRIPE",
        providerPaymentId: `pi_pay_${randomUUID()}`,
        occurredAt: new Date(),
      },
    );
    const caseRecord = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: payment.id,
        amountAtRisk: 90000n,
        currency: "INR",
        riskScore: 70,
        status: "STOPPED",
        attributionWindowHours: 72,
        openedAt: new Date(Date.now() - 24 * 3600 * 1000),
      },
    );

    const match = await findMatchingPaymentForAttribution(
      { db },
      { tenantId: tenant.id, caseRecord },
    );
    expect(match?.id).toBe(payment.id);
  });

  it("SUBSCRIPTION path unchanged: same-subscription payment still attributes", async () => {
    const tenant = await createTenant(
      { db },
      {
        name: `attr-sub ${randomUUID()}`,
        slug: `attr-sub-${randomUUID().slice(0, 8)}`,
      },
    );
    const customer = await createCustomer(
      { db },
      {
        tenantId: tenant.id,
        externalRef: `cust_${randomUUID()}`,
        name: "Attr Sub Customer",
        email: `attr-sub-${randomUUID().slice(0, 8)}@example.com`,
      },
    );
    const subscription = await createSubscription(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        provider: "STRIPE",
        providerSubscriptionId: `sub_${randomUUID()}`,
        planName: "Pro",
        amount: 120000n,
        currency: "INR",
        status: "ACTIVE",
        currentPeriodStart: new Date(Date.now() - 30 * 24 * 3600 * 1000),
      },
    );
    const payment = await createPayment(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        subscriptionId: subscription.id,
        amount: 120000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "STRIPE",
        providerPaymentId: `pi_sub_${randomUUID()}`,
        occurredAt: new Date(),
      },
    );
    const caseRecord = await createCase(
      { db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "SUBSCRIPTION",
        sourceEntityId: subscription.id,
        amountAtRisk: 120000n,
        currency: "INR",
        riskScore: 70,
        status: "STOPPED",
        attributionWindowHours: 72,
        openedAt: new Date(Date.now() - 24 * 3600 * 1000),
      },
    );

    const match = await findMatchingPaymentForAttribution(
      { db },
      { tenantId: tenant.id, caseRecord },
    );
    expect(match?.id).toBe(payment.id);
  });
});
