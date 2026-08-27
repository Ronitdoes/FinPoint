import { describe, it, expect } from "vitest";
import {
  calculateRiskBand,
  evaluateAmountHighRule,
  evaluateCustomerActiveRule,
  evaluateDaysOverdueRule,
  evaluateHighCheckoutIntentRule,
  evaluateHistoricalPaymentSuccessRule,
  evaluatePaymentFailedCountRules,
  DEFAULT_AMOUNT_HIGH_MINOR_UNITS,
  DEFAULT_CHECKOUT_INTENT_MINOR_UNITS,
} from "./rules";
import { scorePaymentFailure } from "./score-payment-failure";
import { scoreCheckout } from "./score-checkout";
import { scoreInvoice } from "./score-invoice";
import type { Customer, Payment, Invoice, Checkout } from "@repo/db";
import type { SubjectAggregates } from "../risk.types";

describe("Risk Engine v1 — Scoring Rules Unit Tests (Step 12)", () => {
  const dummyCustomer: Customer = {
    id: "cus_00000000-0000-0000-0000-000000000001",
    tenantId: "ten_00000000-0000-0000-0000-000000000001",
    externalRef: "cust_ext_1",
    name: "Acme Corp",
    email: "billing@acme.com",
    phone: "+919876543210",
    status: "ACTIVE",
    lifetimeValue: 100000n,
    optedOut: false,
    optedOutAt: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  describe("Band Thresholds & Score Capping", () => {
    const bandTestCases = [
      { score: -10, expected: "LOW" },
      { score: 0, expected: "LOW" },
      { score: 39, expected: "LOW" },
      { score: 40, expected: "MEDIUM" },
      { score: 59, expected: "MEDIUM" },
      { score: 60, expected: "HIGH" },
      { score: 84, expected: "HIGH" },
      { score: 85, expected: "CRITICAL" },
      { score: 100, expected: "CRITICAL" },
      { score: 150, expected: "CRITICAL" },
    ] as const;

    it.each(bandTestCases)(
      "maps score $score to exact band $expected",
      ({ score, expected }) => {
        expect(calculateRiskBand(score)).toBe(expected);
      },
    );
  });

  describe("Rule: payment_failed_count >= 1 (+20) and >= 2 (+20, cumulative +40)", () => {
    it("fires 0 points when count is 0", () => {
      const factors = evaluatePaymentFailedCountRules(0);
      expect(factors[0].matched).toBe(false);
      expect(factors[0].points).toBe(0);
      expect(factors[1].matched).toBe(false);
      expect(factors[1].points).toBe(0);
    });

    it("fires +20 points when count is 1", () => {
      const factors = evaluatePaymentFailedCountRules(1);
      expect(factors[0].matched).toBe(true);
      expect(factors[0].points).toBe(20);
      expect(factors[1].matched).toBe(false);
      expect(factors[1].points).toBe(0);
    });

    it("fires cumulative +40 points when count is 2", () => {
      const factors = evaluatePaymentFailedCountRules(2);
      expect(factors[0].matched).toBe(true);
      expect(factors[0].points).toBe(20);
      expect(factors[1].matched).toBe(true);
      expect(factors[1].points).toBe(20);
      expect(factors[0].points + factors[1].points).toBe(40);
    });

    it("fires cumulative +40 points when count is 5", () => {
      const factors = evaluatePaymentFailedCountRules(5);
      expect(factors[0].matched).toBe(true);
      expect(factors[1].matched).toBe(true);
      expect(factors[0].points + factors[1].points).toBe(40);
    });

    it("supports configurable weight overrides", () => {
      const factors = evaluatePaymentFailedCountRules(2, {
        weights: { payment_failed_1: 25, payment_failed_2: 30 },
      });
      expect(factors[0].points).toBe(25);
      expect(factors[1].points).toBe(30);
      expect(factors[0].points + factors[1].points).toBe(55);
    });
  });

  describe("Rule: days_overdue >= 3 (+15 for invoices)", () => {
    const now = new Date("2026-08-27T12:00:00.000Z");

    it("does not fire when invoice is not yet due (0 days overdue)", () => {
      const dueAt = new Date("2026-08-28T12:00:00.000Z");
      const factor = evaluateDaysOverdueRule(dueAt, now);
      expect(factor.matched).toBe(false);
      expect(factor.points).toBe(0);
    });

    it("does not fire at boundary of 2 days overdue (< 3)", () => {
      const dueAt = new Date("2026-08-25T12:00:00.000Z"); // exactly 2 days
      const factor = evaluateDaysOverdueRule(dueAt, now);
      expect(factor.matched).toBe(false);
      expect(factor.points).toBe(0);
    });

    it("fires at boundary of 3 days overdue (>= 3)", () => {
      const dueAt = new Date("2026-08-24T12:00:00.000Z"); // exactly 3 days
      const factor = evaluateDaysOverdueRule(dueAt, now);
      expect(factor.matched).toBe(true);
      expect(factor.points).toBe(15);
    });

    it("fires when overdue by 10 days", () => {
      const dueAt = new Date("2026-08-17T12:00:00.000Z"); // 10 days
      const factor = evaluateDaysOverdueRule(dueAt, now);
      expect(factor.matched).toBe(true);
      expect(factor.points).toBe(15);
    });

    it("supports configurable overdue threshold & weight overrides", () => {
      const dueAt = new Date("2026-08-25T12:00:00.000Z"); // 2 days
      const factor = evaluateDaysOverdueRule(dueAt, now, {
        thresholds: { overdue_days: 2 },
        weights: { days_overdue_3: 20 },
      });
      expect(factor.matched).toBe(true);
      expect(factor.points).toBe(20);
    });
  });

  describe("Rule: amount_high (+10) (>= ₹50,000)", () => {
    it("does not fire when amount is below threshold (e.g. ₹49,999)", () => {
      const factor = evaluateAmountHighRule(DEFAULT_AMOUNT_HIGH_MINOR_UNITS - 1n);
      expect(factor.matched).toBe(false);
      expect(factor.points).toBe(0);
    });

    it("fires at exact threshold boundary (₹50,000 = 5,000,000 paise)", () => {
      const factor = evaluateAmountHighRule(DEFAULT_AMOUNT_HIGH_MINOR_UNITS);
      expect(factor.matched).toBe(true);
      expect(factor.points).toBe(10);
    });

    it("fires above threshold (e.g. ₹100,000)", () => {
      const factor = evaluateAmountHighRule(10_000_000n);
      expect(factor.matched).toBe(true);
      expect(factor.points).toBe(10);
    });

    it("supports configurable threshold override", () => {
      const factor = evaluateAmountHighRule(1_000_000n, {
        thresholds: { amount_high_minor_units: 1_000_000n },
        weights: { amount_high: 12 },
      });
      expect(factor.matched).toBe(true);
      expect(factor.points).toBe(12);
    });
  });

  describe("Rule: customer_active (+10)", () => {
    const now = new Date("2026-08-27T12:00:00.000Z");

    it("fires when customer status is ACTIVE", () => {
      const factor = evaluateCustomerActiveRule(dummyCustomer, [], now);
      expect(factor.matched).toBe(true);
      expect(factor.points).toBe(10);
    });

    it("fires when customer has active subscription even if status is CHURNED", () => {
      const inactiveCust = { ...dummyCustomer, status: "CHURNED" as const };
      const subs = [
        {
          id: "sub_1",
          tenantId: "ten_1",
          customerId: "cus_1",
          planName: "Pro",
          amount: 5000n,
          currency: "INR",
          status: "ACTIVE" as const,
          provider: "STRIPE" as const,
          providerSubscriptionId: "sub_ext_1",
          currentPeriodStart: now,
          currentPeriodEnd: now,
          cancelledAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ];
      const factor = evaluateCustomerActiveRule(inactiveCust, subs, now);
      expect(factor.matched).toBe(true);
      expect(factor.points).toBe(10);
    });
  });

  describe("Rule: historical_payment_success (+10) (>= 3 successful payments)", () => {
    const now = new Date("2026-08-27T12:00:00.000Z");

    it("does not fire when successful payments < 3", () => {
      const history = [
        {
          id: "p_1",
          tenantId: "ten_1",
          customerId: "cus_1",
          amount: 1000n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: "pi_1",
          occurredAt: now,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "p_2",
          tenantId: "ten_1",
          customerId: "cus_1",
          amount: 1000n,
          currency: "INR",
          status: "SUCCEEDED",
          provider: "STRIPE",
          providerPaymentId: "pi_2",
          occurredAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ] as unknown as Payment[];
      const factor = evaluateHistoricalPaymentSuccessRule(history, now);
      expect(factor.matched).toBe(false);
      expect(factor.points).toBe(0);
    });

    it("fires at boundary of 3 successful payments", () => {
      const history = [1, 2, 3].map((i) => ({
        id: `p_${i}`,
        tenantId: "ten_1",
        customerId: "cus_1",
        amount: 1000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "STRIPE",
        providerPaymentId: `pi_${i}`,
        occurredAt: now,
        createdAt: now,
        updatedAt: now,
      })) as unknown as Payment[];
      const factor = evaluateHistoricalPaymentSuccessRule(history, now);
      expect(factor.matched).toBe(true);
      expect(factor.points).toBe(10);
    });
  });

  describe("Rule: high_checkout_intent (+15)", () => {
    it("does not fire when cart is low and payment was not started", () => {
      const factor = evaluateHighCheckoutIntentRule("STARTED", 100_000n);
      expect(factor.matched).toBe(false);
      expect(factor.points).toBe(0);
    });

    it("fires when status is PAYMENT_STARTED regardless of cart value", () => {
      const factor = evaluateHighCheckoutIntentRule("PAYMENT_STARTED", 10_000n);
      expect(factor.matched).toBe(true);
      expect(factor.points).toBe(15);
    });

    it("fires when cart_value >= ₹5,000 even if payment was not started", () => {
      const factor = evaluateHighCheckoutIntentRule("STARTED", DEFAULT_CHECKOUT_INTENT_MINOR_UNITS);
      expect(factor.matched).toBe(true);
      expect(factor.points).toBe(15);
    });
  });

  describe("Scorer: Payment Failure (scorePaymentFailure)", () => {
    it("evaluates minimum payment failure score (count=1, customer_active=10, amount_low, no history) -> 30 LOW", () => {
      const aggregates: SubjectAggregates = {
        tenantId: dummyCustomer.tenantId,
        customerId: dummyCustomer.id,
        customer: dummyCustomer,
        payment: {
          id: "pay_1",
          tenantId: dummyCustomer.tenantId,
          customerId: dummyCustomer.id,
          amount: 2000n,
          currency: "INR",
          status: "FAILED",
          provider: "STRIPE",
          providerPaymentId: "pi_1",
          occurredAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        } as unknown as Payment,
        paymentsHistory: [],
        paymentAttempts: [],
      };

      const result = scorePaymentFailure(aggregates);
      // payment_failed_1 (+20) + customer_active (+10) = 30
      expect(result.score).toBe(30);
      expect(result.band).toBe("LOW");
      expect(result.riskType).toBe("PAYMENT_FAILURE");
      expect(result.factors.rules).toHaveLength(5);
    });

    it("caps score at 100 under heavy cumulative rules", () => {
      const now = new Date();
      const aggregates: SubjectAggregates = {
        tenantId: dummyCustomer.tenantId,
        customerId: dummyCustomer.id,
        customer: dummyCustomer,
        payment: {
          id: "pay_1",
          tenantId: dummyCustomer.tenantId,
          customerId: dummyCustomer.id,
          amount: 10_000_000n, // High amount (+10)
          currency: "INR",
          status: "FAILED",
          provider: "STRIPE",
          providerPaymentId: "pi_1",
          occurredAt: now,
          createdAt: now,
          updatedAt: now,
        } as unknown as Payment,
        paymentsHistory: [
          { status: "FAILED" },
          { status: "FAILED" },
          { status: "SUCCEEDED", occurredAt: now },
          { status: "SUCCEEDED", occurredAt: now },
          { status: "SUCCEEDED", occurredAt: now },
        ] as any[],
      };

      const result = scorePaymentFailure(aggregates, {
        weights: {
          payment_failed_1: 40,
          payment_failed_2: 40,
          amount_high: 20,
          customer_active: 20,
          historical_payment_success: 20,
        },
      });

      expect(result.score).toBe(100);
      expect(result.band).toBe("CRITICAL");
    });
  });

  describe("Scorer: Checkout Abandonment (scoreCheckout)", () => {
    it("evaluates checkout with high cart and intent", () => {
      const checkout = {
        id: "chk_1",
        tenantId: dummyCustomer.tenantId,
        customerId: dummyCustomer.id,
        cartValue: 6_000_000n, // High amount >= 50k (+10) & high intent >= 5k (+15)
        currency: "INR",
        items: [],
        status: "PAYMENT_STARTED",
        startedAt: new Date(),
        lastActivityAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as Checkout;

      const aggregates: SubjectAggregates = {
        tenantId: dummyCustomer.tenantId,
        customerId: dummyCustomer.id,
        customer: dummyCustomer, // active (+10)
        checkout,
        paymentsHistory: [],
      };

      const result = scoreCheckout(aggregates);
      // high_checkout_intent (+15) + amount_high (+10) + customer_active (+10) = 35 -> LOW
      expect(result.score).toBe(35);
      expect(result.band).toBe("LOW");
      expect(result.riskType).toBe("CHECKOUT_ABANDONMENT");
    });
  });

  describe("Scorer: Invoice Overdue (scoreInvoice)", () => {
    it("evaluates invoice overdue by 5 days with high amount", () => {
      const now = new Date("2026-08-27T12:00:00.000Z");
      const dueAt = new Date("2026-08-22T12:00:00.000Z"); // 5 days overdue (+15)

      const invoice = {
        id: "inv_1",
        tenantId: dummyCustomer.tenantId,
        customerId: dummyCustomer.id,
        number: "INV-2026-001",
        amount: 8_000_000n, // amount high (+10)
        amountPaid: 0n,
        currency: "INR",
        status: "OVERDUE",
        dueAt,
        createdAt: dueAt,
        updatedAt: dueAt,
      } as unknown as Invoice;

      const aggregates: SubjectAggregates = {
        tenantId: dummyCustomer.tenantId,
        customerId: dummyCustomer.id,
        customer: dummyCustomer, // active (+10)
        invoice,
        paymentsHistory: [
          { status: "FAILED" }, // prior failure >= 1 (+20)
        ] as any[],
        now,
      };

      const result = scoreInvoice(aggregates);
      // days_overdue (+15) + amount_high (+10) + payment_failed_1 (+20) + customer_active (+10) = 55 -> MEDIUM
      expect(result.score).toBe(55);
      expect(result.band).toBe("MEDIUM");
      expect(result.riskType).toBe("INVOICE_OVERDUE");
    });
  });
});
