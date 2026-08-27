import { describe, it, expect } from "vitest";
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
import type {
  Customer,
  Payment,
  Subscription,
  Invoice,
  Checkout,
  RecoveryCase,
  RecoveryOutcome,
  Message,
  CustomerResponse,
} from "@repo/db";

describe("Step 13: Customer Context Pure Summarizers", () => {
  const referenceNow = new Date("2026-08-27T12:00:00Z");

  describe("summarizeCustomerProfile", () => {
    it("computes tenure in days and masks PII correctly", () => {
      const customer: Customer = {
        id: "a0000000-0000-0000-0000-000000000001",
        tenantId: "t0000000-0000-0000-0000-000000000001",
        externalRef: "cus_123",
        name: "Alice Smith",
        email: "alice.smith@example.com",
        phone: "+14155552671",
        status: "ACTIVE",
        lifetimeValue: 150000n,
        optedOut: false,
        optedOutAt: null,
        metadata: {},
        deletedAt: null,
        createdAt: new Date("2026-05-29T12:00:00Z"), // exactly 90 days prior
        updatedAt: new Date("2026-05-29T12:00:00Z"),
      };

      const result = summarizeCustomerProfile(customer, referenceNow);

      expect(result).toEqual({
        id: "a0000000-0000-0000-0000-000000000001",
        name: "Alice Smith",
        status: "ACTIVE",
        lifetime_value_minor: 150000,
        tenure_days: 90,
        opted_out: false,
        email_masked: "a***@e***.com",
        phone_masked: "+1***2671",
      });
    });

    it("handles customer with null email and phone gracefully", () => {
      const customer: Customer = {
        id: "a0000000-0000-0000-0000-000000000002",
        tenantId: "t0000000-0000-0000-0000-000000000001",
        externalRef: null,
        name: "Anonymous User",
        email: null,
        phone: null,
        status: "CHURNED",
        lifetimeValue: 0n,
        optedOut: true,
        optedOutAt: new Date("2026-08-01T00:00:00Z"),
        metadata: {},
        deletedAt: null,
        createdAt: referenceNow,
        updatedAt: referenceNow,
      };

      const result = summarizeCustomerProfile(customer, referenceNow);

      expect(result.tenure_days).toBe(0);
      expect(result.opted_out).toBe(true);
      expect(result.email_masked).toBeNull();
      expect(result.phone_masked).toBeNull();
    });
  });

  describe("summarizePayments", () => {
    it("aggregates 180d window, failure codes, and averages", () => {
      const payments: Payment[] = [
        {
          id: "p1",
          tenantId: "t1",
          customerId: "c1",
          subscriptionId: null,
          amount: 5000n,
          currency: "USD",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: "pi_1",
          failureCode: null,
          failureMessage: null,
          methodMetadata: {},
          occurredAt: new Date("2026-08-20T00:00:00Z"), // 7d ago
          paidAt: new Date("2026-08-20T00:00:00Z"),
          refundedAt: null,
          disputedAt: null,
          createdAt: new Date("2026-08-20T00:00:00Z"),
          updatedAt: new Date("2026-08-20T00:00:00Z"),
        },
        {
          id: "p2",
          tenantId: "t1",
          customerId: "c1",
          subscriptionId: null,
          amount: 5000n,
          currency: "USD",
          status: "FAILED",
          provider: "STRIPE",
          providerPaymentId: "pi_2",
          failureCode: "insufficient_funds",
          failureMessage: "Not enough funds",
          methodMetadata: {},
          occurredAt: new Date("2026-08-26T00:00:00Z"), // 1d ago
          paidAt: null,
          refundedAt: null,
          disputedAt: null,
          createdAt: new Date("2026-08-26T00:00:00Z"),
          updatedAt: new Date("2026-08-26T00:00:00Z"),
        },
        {
          id: "p3",
          tenantId: "t1",
          customerId: "c1",
          subscriptionId: null,
          amount: 10000n,
          currency: "USD",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: "pi_3",
          failureCode: null,
          failureMessage: null,
          methodMetadata: {},
          occurredAt: new Date("2025-10-01T00:00:00Z"), // >180d ago
          paidAt: new Date("2025-10-01T00:00:00Z"),
          refundedAt: null,
          disputedAt: null,
          createdAt: new Date("2025-10-01T00:00:00Z"),
          updatedAt: new Date("2025-10-01T00:00:00Z"),
        },
      ];

      const result = summarizePayments(payments, referenceNow);

      expect(result.succeeded_count_180d).toBe(1);
      expect(result.failed_count_180d).toBe(1);
      expect(result.last_success_at).toBe("2026-08-20T00:00:00.000Z");
      expect(result.last_failure_at).toBe("2026-08-26T00:00:00.000Z");
      expect(result.last_failure_code).toBe("insufficient_funds");
      expect(result.total_paid_minor).toBe(15000);
      expect(result.avg_amount_minor).toBe(7500); // 15000 / 2 succeeded payments
    });

    it("returns zeroed shape for empty payments array", () => {
      const result = summarizePayments([], referenceNow);
      expect(result).toEqual({
        succeeded_count_180d: 0,
        failed_count_180d: 0,
        last_success_at: null,
        last_failure_at: null,
        last_failure_code: null,
        avg_amount_minor: 0,
        total_paid_minor: 0,
      });
    });
  });

  describe("summarizeSubscriptions", () => {
    it("identifies active subscription and counts renewals and past due events", () => {
      const subscriptions: Subscription[] = [
        {
          id: "sub_1",
          tenantId: "t1",
          customerId: "c1",
          planName: "Pro Tier Monthly",
          amount: 2900n,
          currency: "USD",
          status: "ACTIVE",
          provider: "STRIPE",
          providerSubscriptionId: "sub_ext_1",
          currentPeriodStart: new Date("2026-08-01T00:00:00Z"),
          currentPeriodEnd: new Date("2026-09-01T00:00:00Z"),
          cancelledAt: null,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-08-01T00:00:00Z"),
        },
      ];

      const payments: Payment[] = [
        {
          id: "p1",
          tenantId: "t1",
          customerId: "c1",
          subscriptionId: "sub_1",
          amount: 2900n,
          currency: "USD",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: "pi_1",
          failureCode: null,
          failureMessage: null,
          methodMetadata: {},
          occurredAt: new Date("2026-06-01T00:00:00Z"),
          paidAt: new Date("2026-06-01T00:00:00Z"),
          refundedAt: null,
          disputedAt: null,
          createdAt: new Date("2026-06-01T00:00:00Z"),
          updatedAt: new Date("2026-06-01T00:00:00Z"),
        },
        {
          id: "p2",
          tenantId: "t1",
          customerId: "c1",
          subscriptionId: "sub_1",
          amount: 2900n,
          currency: "USD",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: "pi_2",
          failureCode: null,
          failureMessage: null,
          methodMetadata: {},
          occurredAt: new Date("2026-07-01T00:00:00Z"),
          paidAt: new Date("2026-07-01T00:00:00Z"),
          refundedAt: null,
          disputedAt: null,
          createdAt: new Date("2026-07-01T00:00:00Z"),
          updatedAt: new Date("2026-07-01T00:00:00Z"),
        },
        {
          id: "p3",
          tenantId: "t1",
          customerId: "c1",
          subscriptionId: "sub_1",
          amount: 2900n,
          currency: "USD",
          status: "FAILED",
          provider: "STRIPE",
          providerPaymentId: "pi_3",
          failureCode: "card_declined",
          failureMessage: "Card was declined",
          methodMetadata: {},
          occurredAt: new Date("2026-08-01T00:00:00Z"),
          paidAt: null,
          refundedAt: null,
          disputedAt: null,
          createdAt: new Date("2026-08-01T00:00:00Z"),
          updatedAt: new Date("2026-08-01T00:00:00Z"),
        },
      ];

      const result = summarizeSubscriptions(subscriptions, payments, referenceNow);

      expect(result.status).toBe("ACTIVE");
      expect(result.plan_name).toBe("Pro Tier Monthly");
      expect(result.amount_minor).toBe(2900);
      expect(result.renewals_count).toBe(2);
      expect(result.past_due_events).toBe(1);
    });

    it("returns null-safe empty summary when no subscriptions exist", () => {
      const result = summarizeSubscriptions([], [], referenceNow);
      expect(result).toEqual({
        status: null,
        plan_name: null,
        amount_minor: 0,
        renewals_count: 0,
        past_due_events: 0,
      });
    });
  });

  describe("summarizeInvoices", () => {
    it("computes open count, overdue count, worst days overdue and total overdue minor", () => {
      const invoices: Invoice[] = [
        {
          id: "inv_1",
          tenantId: "t1",
          customerId: "c1",
          number: "INV-001",
          amount: 50000n,
          amountPaid: 10000n,
          currency: "USD",
          status: "OVERDUE",
          issuedAt: new Date("2026-08-01T00:00:00Z"),
          dueAt: new Date("2026-08-15T00:00:00Z"), // 12 days overdue relative to Aug 27
          paidAt: null,
          disputedAt: null,
          provider: "STRIPE",
          providerInvoiceId: "in_1",
          createdAt: new Date("2026-08-01T00:00:00Z"),
          updatedAt: new Date("2026-08-15T00:00:00Z"),
        },
        {
          id: "inv_2",
          tenantId: "t1",
          customerId: "c1",
          number: "INV-002",
          amount: 20000n,
          amountPaid: 0n,
          currency: "USD",
          status: "DUE",
          issuedAt: new Date("2026-08-20T00:00:00Z"),
          dueAt: new Date("2026-09-01T00:00:00Z"), // future due date (not overdue)
          paidAt: null,
          disputedAt: null,
          provider: "STRIPE",
          providerInvoiceId: "in_2",
          createdAt: new Date("2026-08-20T00:00:00Z"),
          updatedAt: new Date("2026-08-20T00:00:00Z"),
        },
        {
          id: "inv_3",
          tenantId: "t1",
          customerId: "c1",
          number: "INV-003",
          amount: 15000n,
          amountPaid: 15000n,
          currency: "USD",
          status: "PAID",
          issuedAt: new Date("2026-07-01T00:00:00Z"),
          dueAt: new Date("2026-07-15T00:00:00Z"),
          paidAt: new Date("2026-07-10T00:00:00Z"),
          disputedAt: null,
          provider: "STRIPE",
          providerInvoiceId: "in_3",
          createdAt: new Date("2026-07-01T00:00:00Z"),
          updatedAt: new Date("2026-07-10T00:00:00Z"),
        },
      ];

      const result = summarizeInvoices(invoices, referenceNow);

      expect(result.open_count).toBe(2);
      expect(result.overdue_count).toBe(1);
      expect(result.worst_days_overdue).toBe(12);
      expect(result.total_overdue_minor).toBe(40000); // 50000 - 10000
    });
  });

  describe("summarizeCheckouts", () => {
    it("tracks active carts, 90d abandoned carts, and latest cart value", () => {
      const checkouts: Checkout[] = [
        {
          id: "chk_1",
          tenantId: "t1",
          customerId: "c1",
          cartValue: 12500n,
          currency: "USD",
          items: [],
          status: "STARTED",
          sourceRef: "ref_1",
          startedAt: new Date("2026-08-27T10:00:00Z"),
          lastActivityAt: new Date("2026-08-27T10:30:00Z"),
          completedAt: null,
          abandonedAt: null,
          expiresAt: null,
          createdAt: new Date("2026-08-27T10:00:00Z"),
          updatedAt: new Date("2026-08-27T10:30:00Z"),
        },
        {
          id: "chk_2",
          tenantId: "t1",
          customerId: "c1",
          cartValue: 8000n,
          currency: "USD",
          items: [],
          status: "ABANDONED",
          sourceRef: "ref_2",
          startedAt: new Date("2026-07-15T00:00:00Z"),
          lastActivityAt: new Date("2026-07-15T01:00:00Z"),
          completedAt: null,
          abandonedAt: new Date("2026-07-15T02:00:00Z"), // ~43d ago (<90d)
          expiresAt: null,
          createdAt: new Date("2026-07-15T00:00:00Z"),
          updatedAt: new Date("2026-07-15T02:00:00Z"),
        },
      ];

      const result = summarizeCheckouts(checkouts, referenceNow);

      expect(result.active_carts).toBe(1);
      expect(result.abandoned_count_90d).toBe(1);
      expect(result.last_cart_value_minor).toBe(12500);
    });
  });

  describe("summarizeRecoveryHistory", () => {
    it("computes case breakdown, last outcome snapshot, and retry success rate", () => {
      const cases: RecoveryCase[] = [
        {
          id: "case_1",
          tenantId: "t1",
          caseNumber: 101,
          customerId: "c1",
          riskId: null,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "payments",
          sourceEntityId: "p1",
          amountAtRisk: 5000n,
          currency: "USD",
          riskScore: 75,
          status: "RECOVERED",
          statusReason: "Recovered via retry",
          stopConditions: [],
          assignedTo: null,
          workflowId: null,
          attributionWindowHours: 72,
          openedAt: new Date("2026-08-01T00:00:00Z"),
          closedAt: new Date("2026-08-02T00:00:00Z"),
          createdAt: new Date("2026-08-01T00:00:00Z"),
          updatedAt: new Date("2026-08-02T00:00:00Z"),
        },
        {
          id: "case_2",
          tenantId: "t1",
          caseNumber: 102,
          customerId: "c1",
          riskId: null,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "payments",
          sourceEntityId: "p2",
          amountAtRisk: 3000n,
          currency: "USD",
          riskScore: 60,
          status: "STOPPED",
          statusReason: "Opted out",
          stopConditions: [],
          assignedTo: null,
          workflowId: null,
          attributionWindowHours: 72,
          openedAt: new Date("2026-08-10T00:00:00Z"),
          closedAt: new Date("2026-08-11T00:00:00Z"),
          createdAt: new Date("2026-08-10T00:00:00Z"),
          updatedAt: new Date("2026-08-11T00:00:00Z"),
        },
      ];

      const outcomes: RecoveryOutcome[] = [
        {
          id: "out_1",
          tenantId: "t1",
          caseId: "case_1",
          paymentId: "p1",
          baselineAmount: 5000n,
          recoveredAmount: 5000n,
          recoveryCost: 150n,
          netRecovered: 4850n,
          attributionMethod: "DIRECT_PAYMENT",
          attributionWindowHours: 72,
          recoveredAt: new Date("2026-08-02T00:00:00Z"),
          recordedAt: new Date("2026-08-02T00:00:00Z"),
          createdAt: new Date("2026-08-02T00:00:00Z"),
          updatedAt: new Date("2026-08-02T00:00:00Z"),
        },
      ];

      const result = summarizeRecoveryHistory(cases, outcomes);

      expect(result.prior_cases).toBe(2);
      expect(result.recovered_cases).toBe(1);
      expect(result.stopped_cases).toBe(1);
      expect(result.escalated_cases).toBe(0);
      expect(result.last_outcome).toEqual({
        case_id: "case_1",
        amount_recovered_minor: 5000,
        at: "2026-08-02T00:00:00.000Z",
      });
      expect(result.retry_success_rate).toBe(0.5);
    });
  });

  describe("summarizeCommunicationHistory", () => {
    it("computes channel window frequencies, reply rate, and opt-out timestamp", () => {
      const messages: Message[] = [
        {
          id: "m1",
          tenantId: "t1",
          caseId: "c1",
          customerId: "cust1",
          channel: "WHATSAPP",
          direction: "OUTBOUND",
          templateId: "tpl_1",
          variables: {},
          toAddress: "+14155552671",
          provider: "MOCK",
          providerMessageId: "w1",
          idempotencyKey: "k1",
          status: "DELIVERED",
          sentAt: new Date("2026-08-25T00:00:00Z"), // 2d ago (<7d)
          finalStatusAt: new Date("2026-08-25T00:01:00Z"),
          createdAt: new Date("2026-08-25T00:00:00Z"),
          updatedAt: new Date("2026-08-25T00:01:00Z"),
        },
        {
          id: "m2",
          tenantId: "t1",
          caseId: "c1",
          customerId: "cust1",
          channel: "EMAIL",
          direction: "OUTBOUND",
          templateId: "tpl_2",
          variables: {},
          toAddress: "alice@example.com",
          provider: "MOCK",
          providerMessageId: "e1",
          idempotencyKey: "k2",
          status: "DELIVERED",
          sentAt: new Date("2026-08-20T00:00:00Z"), // 7d ago (<14d)
          finalStatusAt: new Date("2026-08-20T00:01:00Z"),
          createdAt: new Date("2026-08-20T00:00:00Z"),
          updatedAt: new Date("2026-08-20T00:01:00Z"),
        },
      ];

      const responses: CustomerResponse[] = [
        {
          id: "r1",
          tenantId: "t1",
          customerId: "cust1",
          caseId: "c1",
          channel: "WHATSAPP",
          type: "PROMISE_TO_PAY",
          contentRedacted: "Will pay tomorrow",
          rawRef: "ref_r1",
          receivedAt: new Date("2026-08-25T02:00:00Z"),
          createdAt: new Date("2026-08-25T02:00:00Z"),
          updatedAt: new Date("2026-08-25T02:00:00Z"),
        },
      ];

      const customer: Customer = {
        id: "cust1",
        tenantId: "t1",
        externalRef: null,
        name: "Alice",
        email: "alice@example.com",
        phone: "+14155552671",
        status: "ACTIVE",
        lifetimeValue: 0n,
        optedOut: false,
        optedOutAt: null,
        metadata: {},
        deletedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      };

      const result = summarizeCommunicationHistory(messages, responses, customer, referenceNow);

      expect(result.whatsapp_last_7d).toBe(1);
      expect(result.email_last_14d).toBe(1);
      expect(result.sms_last_7d).toBe(0);
      expect(result.last_contacted_at).toBe("2026-08-25T00:00:00.000Z");
      expect(result.reply_rate).toBe(0.5); // 1 response / 2 messages
      expect(result.opt_out_at).toBeNull();
    });
  });

  describe("summarizePreferences", () => {
    it("extracts preferred channel and language from customer metadata with fallback", () => {
      const customer: Customer = {
        id: "c1",
        tenantId: "t1",
        externalRef: null,
        name: "Alice",
        email: "alice@example.com",
        phone: null,
        status: "ACTIVE",
        lifetimeValue: 0n,
        optedOut: false,
        optedOutAt: null,
        metadata: {
          preferred_channel: "WHATSAPP",
          language: "es",
        },
        deletedAt: null,
        createdAt: referenceNow,
        updatedAt: referenceNow,
      };

      const result = summarizePreferences(customer, []);

      expect(result).toEqual({
        preferred_channel: "WHATSAPP",
        language: "es",
      });
    });
  });
});
