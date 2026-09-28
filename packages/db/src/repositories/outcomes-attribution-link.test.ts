import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  isPaymentLinkedToInvoice,
  isPaymentLinkedToCheckout,
} from "./outcomes.repo";
import type { Payment } from "../schema/payments";
import type { Invoice } from "../schema/invoices";
import type { Checkout } from "../schema/checkouts";

function basePayment(
  overrides: Partial<Payment> = {},
): Payment {
  const now = new Date();
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    customerId: randomUUID(),
    subscriptionId: null,
    amount: 100000n,
    currency: "INR",
    status: "SUCCEEDED",
    provider: "STRIPE",
    providerPaymentId: `pi_${randomUUID()}`,
    failureCode: null,
    failureMessage: null,
    methodMetadata: {},
    occurredAt: now,
    paidAt: now,
    refundedAt: null,
    disputedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Payment;
}

function baseInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date();
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    customerId: randomUUID(),
    number: `INV-${randomUUID().slice(0, 8)}`,
    amount: 100000n,
    amountPaid: 0n,
    currency: "INR",
    status: "OVERDUE",
    issuedAt: null,
    dueAt: now,
    paidAt: null,
    disputedAt: null,
    provider: null,
    providerInvoiceId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Invoice;
}

function baseCheckout(overrides: Partial<Checkout> = {}): Checkout {
  const now = new Date();
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    customerId: randomUUID(),
    cartValue: 60000n,
    currency: "INR",
    items: [],
    status: "ABANDONED",
    sourceRef: null,
    startedAt: now,
    lastActivityAt: now,
    completedAt: null,
    abandonedAt: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as Checkout;
}

/**
 * Pure unit coverage for the P1 strict-link fix (no DB required).
 * Same-customer unrelated payments carry no link evidence => false
 * (caller returns null / no attribution). Linked payments => true.
 */
describe("outcomes attribution link evidence (pure unit, no DB)", () => {
  it("INVOICE: unrelated same-customer payment => not linked", () => {
    const invoice = baseInvoice();
    const payment = basePayment({ methodMetadata: { brand: "visa" } });
    expect(
      isPaymentLinkedToInvoice(payment, invoice, invoice.id),
    ).toBe(false);
  });

  it("INVOICE: methodMetadata invoice_id => linked", () => {
    const invoice = baseInvoice();
    const payment = basePayment({
      methodMetadata: { invoice_id: invoice.id },
    });
    expect(isPaymentLinkedToInvoice(payment, invoice, invoice.id)).toBe(true);
  });

  it("INVOICE: provider reference equality => linked", () => {
    const providerInvoiceId = `in_${randomUUID().slice(0, 8)}`;
    const invoice = baseInvoice({
      provider: "STRIPE",
      providerInvoiceId,
    });
    const payment = basePayment({ providerPaymentId: providerInvoiceId });
    expect(isPaymentLinkedToInvoice(payment, invoice, invoice.id)).toBe(true);
  });

  it("CHECKOUT: unrelated same-customer payment => not linked", () => {
    const checkout = baseCheckout({
      sourceRef: `chk_${randomUUID().slice(0, 8)}`,
    });
    const payment = basePayment({ methodMetadata: { method: "upi" } });
    expect(
      isPaymentLinkedToCheckout(payment, checkout, checkout.id),
    ).toBe(false);
  });

  it("CHECKOUT: sourceRef metadata => linked", () => {
    const sourceRef = `chk_${randomUUID().slice(0, 8)}`;
    const checkout = baseCheckout({ sourceRef });
    const payment = basePayment({
      methodMetadata: { source_ref: sourceRef },
    });
    expect(isPaymentLinkedToCheckout(payment, checkout, checkout.id)).toBe(
      true,
    );
  });

  it("CHECKOUT: provider reference equality => linked", () => {
    const sourceRef = `chk_${randomUUID().slice(0, 8)}`;
    const checkout = baseCheckout({ sourceRef });
    const payment = basePayment({ providerPaymentId: sourceRef });
    expect(isPaymentLinkedToCheckout(payment, checkout, checkout.id)).toBe(
      true,
    );
  });
});
