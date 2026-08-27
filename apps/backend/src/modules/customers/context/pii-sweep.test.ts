import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  summarizeCustomerProfile,
  summarizePayments,
  summarizeSubscriptions,
  summarizeInvoices,
  summarizeCheckouts,
  summarizeRecoveryHistory,
  summarizeCommunicationHistory,
  summarizePreferences,
} from "./summarize";
import { projectAllowlist, CUSTOMER_CONTEXT_ALLOWLIST } from "./allowlist";
import { CustomerContextSchema, type CustomerContext } from "./types";
import type { Customer } from "@repo/db";

describe("Step 13: PII Regex Sweep Verification", () => {
  const referenceNow = new Date("2026-08-27T12:00:00Z");

  // Regex patterns to detect unmasked PII leaks
  const UNMASKED_EMAIL_REGEX = /\b[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]{2,}\.[A-Za-z]{2,}\b/g;
  const RAW_CREDIT_CARD_REGEX = /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12}|(?:4\d{3}|5[1-5]\d{2}|6011)[- ]?\d{4}[- ]?\d{4}[- ]?\d{4})\b/g;
  const RAW_PHONE_REGEX = /(?<![a-zA-Z0-9-])(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?![a-zA-Z0-9-])/g;

  function generateSyntheticCustomerContext(seed: number): CustomerContext {
    const rawCustomerEmail = `user_${seed}.smith@corporate-domain${seed}.com`;
    const rawCustomerPhone = `+1${String(4150000000 + seed)}`;

    const customer: Customer = {
      id: randomUUID(),
      tenantId: randomUUID(),
      externalRef: `cus_ext_${seed}`,
      name: `Customer Name ${seed}`,
      email: rawCustomerEmail,
      phone: rawCustomerPhone,
      status: seed % 2 === 0 ? "ACTIVE" : "CHURNED",
      lifetimeValue: BigInt(seed * 1000),
      optedOut: seed % 5 === 0,
      optedOutAt: seed % 5 === 0 ? referenceNow : null,
      metadata: {
        raw_secret_token: `secret_token_${seed}`,
        payment_card_full: `411111111111${String(seed).padStart(4, "0")}`,
      },
      deletedAt: null,
      createdAt: new Date(referenceNow.getTime() - seed * 24 * 60 * 60 * 1000),
      updatedAt: referenceNow,
    };

    const customerProfile = projectAllowlist(
      summarizeCustomerProfile(customer, referenceNow),
      CUSTOMER_CONTEXT_ALLOWLIST.customer,
    );

    const paymentSummary = projectAllowlist(
      summarizePayments([], referenceNow),
      CUSTOMER_CONTEXT_ALLOWLIST.payment_summary,
    );

    const subscriptionSummary = projectAllowlist(
      summarizeSubscriptions([], [], referenceNow),
      CUSTOMER_CONTEXT_ALLOWLIST.subscription_summary,
    );

    const invoiceSummary = projectAllowlist(
      summarizeInvoices([], referenceNow),
      CUSTOMER_CONTEXT_ALLOWLIST.invoice_summary,
    );

    const checkoutSummary = projectAllowlist(
      summarizeCheckouts([], referenceNow),
      CUSTOMER_CONTEXT_ALLOWLIST.checkout_summary,
    );

    const recoveryHistory = projectAllowlist(
      summarizeRecoveryHistory([], []),
      CUSTOMER_CONTEXT_ALLOWLIST.recovery_history,
    );

    const communicationHistory = projectAllowlist(
      summarizeCommunicationHistory([], [], customer, referenceNow),
      CUSTOMER_CONTEXT_ALLOWLIST.communication_history,
    );

    const preferences = projectAllowlist(
      summarizePreferences(customer, []),
      CUSTOMER_CONTEXT_ALLOWLIST.preferences,
    );

    const rawContext = {
      built_at: referenceNow.toISOString(),
      customer: customerProfile,
      payment_summary: paymentSummary,
      subscription_summary: subscriptionSummary,
      invoice_summary: invoiceSummary,
      checkout_summary: checkoutSummary,
      recovery_history: recoveryHistory,
      communication_history: communicationHistory,
      preferences: preferences,
    };

    return CustomerContextSchema.parse(rawContext);
  }

  it("proves 0 unmasked email/phone/card leaks across 50 diverse customer fixtures", () => {
    for (let i = 1; i <= 50; i++) {
      const context = generateSyntheticCustomerContext(i);
      const serialized = JSON.stringify(context);

      // 1. Check for unmasked emails
      const emailMatches = serialized.match(UNMASKED_EMAIL_REGEX) || [];
      expect(
        emailMatches,
        `Fixture ${i} leaked unmasked email: ${emailMatches.join(", ")}`,
      ).toHaveLength(0);

      // 2. Check for credit card patterns
      const cardMatches = serialized.match(RAW_CREDIT_CARD_REGEX) || [];
      expect(
        cardMatches,
        `Fixture ${i} leaked credit card pattern: ${cardMatches.join(", ")}`,
      ).toHaveLength(0);

      // 3. Check for raw unmasked phone patterns
      const phoneMatches = serialized.match(RAW_PHONE_REGEX) || [];
      expect(
        phoneMatches,
        `Fixture ${i} leaked unmasked phone number: ${phoneMatches.join(", ")}`,
      ).toHaveLength(0);

      // 4. Verify that masked fields exist and follow masked format
      expect(context.customer.email_masked).toMatch(/^[a-zA-Z0-9]\*\*\*@[a-zA-Z0-9]\*\*\*\.[a-zA-Z0-9.-]+$/);
      expect(context.customer.phone_masked).toMatch(/^\+?[0-9*]+$/);
    }
  });
});
