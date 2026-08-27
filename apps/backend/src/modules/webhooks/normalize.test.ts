import { describe, expect, it } from "vitest";
import { normalizeStripeEvent } from "./normalize/stripe";
import { normalizeRazorpayEvent } from "./normalize/razorpay";

describe("Webhook Normalizer Matrix (Step 10)", () => {
  describe("Stripe Event Normalization", () => {
    it("normalizes payment_intent.payment_failed to payment.failed + payment projection", () => {
      const stripeEvent = {
        id: "evt_pi_fail_1",
        type: "payment_intent.payment_failed",
        created: 1700000000,
        data: {
          object: {
            id: "pi_fail_123",
            amount: 4999,
            currency: "usd",
            customer: "cus_stripe_1",
            customer_details: {
              name: "Jane Doe",
              email: "jane@example.com",
            },
            last_payment_error: {
              code: "card_declined",
              decline_code: "insufficient_funds",
              message: "Your card has insufficient funds.",
            },
          },
        },
      };

      const result = normalizeStripeEvent(stripeEvent);
      expect(result.eventType).toBe("payment.failed");
      expect(result.externalEventId).toBe("evt_pi_fail_1");
      expect(result.entityType).toBe("PAYMENT");
      expect(result.entityId).toBe("pi_fail_123");
      expect(result.projections.customer).toEqual({
        externalRef: "cus_stripe_1",
        name: "Jane Doe",
        email: "jane@example.com",
        phone: undefined,
        metadata: { stripe_customer_id: "cus_stripe_1" },
      });
      expect(result.projections.payment).toEqual({
        providerPaymentId: "pi_fail_123",
        amount: 4999n,
        currency: "USD",
        status: "FAILED",
        failureCode: "insufficient_funds",
        failureMessage: "Your card has insufficient funds.",
        methodMetadata: {
          payment_method_type: undefined,
          payment_method: undefined,
        },
        occurredAt: new Date(1700000000 * 1000),
        createAttempt: true,
      });
    });

    it("normalizes payment_intent.succeeded to payment.succeeded", () => {
      const stripeEvent = {
        id: "evt_pi_succ_1",
        type: "payment_intent.succeeded",
        created: 1700000000,
        data: {
          object: {
            id: "pi_succ_123",
            amount: 9900,
            currency: "usd",
            customer: "cus_stripe_2",
          },
        },
      };

      const result = normalizeStripeEvent(stripeEvent);
      expect(result.eventType).toBe("payment.succeeded");
      expect(result.projections.payment?.status).toBe("SUCCEEDED");
      expect(result.projections.payment?.paidAt).toBeDefined();
    });

    it("normalizes charge.refunded to payment.refunded", () => {
      const stripeEvent = {
        id: "evt_ch_ref_1",
        type: "charge.refunded",
        created: 1700000000,
        data: {
          object: {
            id: "ch_123",
            payment_intent: "pi_ref_123",
            amount: 5000,
            currency: "usd",
            customer: "cus_stripe_3",
          },
        },
      };

      const result = normalizeStripeEvent(stripeEvent);
      expect(result.eventType).toBe("payment.refunded");
      expect(result.projections.payment?.status).toBe("REFUNDED");
      expect(result.projections.payment?.providerPaymentId).toBe("pi_ref_123");
    });

    it("normalizes customer.subscription.created to subscription.created", () => {
      const stripeEvent = {
        id: "evt_sub_create_1",
        type: "customer.subscription.created",
        created: 1700000000,
        data: {
          object: {
            id: "sub_123",
            customer: "cus_stripe_4",
            items: {
              data: [
                {
                  plan: {
                    nickname: "Pro Tier",
                    amount: 2900,
                    currency: "usd",
                  },
                },
              ],
            },
            current_period_start: 1700000000,
            current_period_end: 1702592000,
          },
        },
      };

      const result = normalizeStripeEvent(stripeEvent);
      expect(result.eventType).toBe("subscription.created");
      expect(result.projections.subscription?.planName).toBe("Pro Tier");
      expect(result.projections.subscription?.status).toBe("ACTIVE");
    });

    it("normalizes invoice.payment_failed to invoice.overdue", () => {
      const stripeEvent = {
        id: "evt_inv_fail_1",
        type: "invoice.payment_failed",
        created: 1700000000,
        data: {
          object: {
            id: "in_fail_123",
            number: "INV-001",
            amount_due: 15000,
            currency: "usd",
            customer: "cus_stripe_5",
          },
        },
      };

      const result = normalizeStripeEvent(stripeEvent);
      expect(result.eventType).toBe("invoice.overdue");
      expect(result.projections.invoice?.status).toBe("OVERDUE");
    });

    it("normalizes checkout.session.completed to checkout.completed", () => {
      const stripeEvent = {
        id: "evt_cs_comp_1",
        type: "checkout.session.completed",
        created: 1700000000,
        data: {
          object: {
            id: "cs_test_123",
            client_reference_id: "chk_ref_999",
            amount_total: 12000,
            currency: "usd",
            customer: "cus_stripe_6",
          },
        },
      };

      const result = normalizeStripeEvent(stripeEvent);
      expect(result.eventType).toBe("checkout.completed");
      expect(result.projections.checkout?.status).toBe("COMPLETED");
      expect(result.projections.checkout?.cartValue).toBe(12000n);
    });

    it("marks unrecognized Stripe event as UNMAPPED without throwing", () => {
      const stripeEvent = {
        id: "evt_unknown_1",
        type: "tax_rate.created",
        created: 1700000000,
        data: {
          object: {
            id: "txr_123",
          },
        },
      };

      const result = normalizeStripeEvent(stripeEvent);
      expect(result.eventType).toBe("UNMAPPED");
      expect(result.isUnmapped).toBe(true);
      expect(result.projections.payment).toBeUndefined();
    });
  });

  describe("Razorpay Event Normalization", () => {
    it("normalizes payment.failed to payment.failed + payment attempt projection", () => {
      const rzpEvent = {
        event: "payment.failed",
        created_at: 1700000000,
        payload: {
          payment: {
            entity: {
              id: "pay_rzp_fail_1",
              amount: 50000,
              currency: "INR",
              customer_id: "cust_rzp_1",
              email: "rahul@example.in",
              contact: "+919876543210",
              error_code: "BAD_REQUEST_ERROR",
              error_description: "Card expired",
              method: "card",
            },
          },
        },
      };

      const result = normalizeRazorpayEvent(rzpEvent);
      expect(result.eventType).toBe("payment.failed");
      expect(result.entityType).toBe("PAYMENT");
      expect(result.entityId).toBe("pay_rzp_fail_1");
      expect(result.projections.customer).toEqual({
        externalRef: "cust_rzp_1",
        name: "rahul@example.in",
        email: "rahul@example.in",
        phone: "+919876543210",
        metadata: { razorpay_customer_id: "cust_rzp_1" },
      });
      expect(result.projections.payment).toEqual({
        providerPaymentId: "pay_rzp_fail_1",
        amount: 50000n,
        currency: "INR",
        status: "FAILED",
        failureCode: "BAD_REQUEST_ERROR",
        failureMessage: "Card expired",
        methodMetadata: {
          method: "card",
          bank: undefined,
          wallet: undefined,
          vpa: undefined,
        },
        occurredAt: new Date(1700000000 * 1000),
        createAttempt: true,
      });
    });

    it("normalizes payment.captured to payment.succeeded", () => {
      const rzpEvent = {
        event: "payment.captured",
        created_at: 1700000000,
        payload: {
          payment: {
            entity: {
              id: "pay_rzp_succ_1",
              amount: 150000,
              currency: "INR",
              customer_id: "cust_rzp_2",
            },
          },
        },
      };

      const result = normalizeRazorpayEvent(rzpEvent);
      expect(result.eventType).toBe("payment.succeeded");
      expect(result.projections.payment?.status).toBe("SUCCEEDED");
      expect(result.projections.payment?.paidAt).toBeDefined();
    });

    it("normalizes refund.processed to payment.refunded", () => {
      const rzpEvent = {
        event: "refund.processed",
        created_at: 1700000000,
        payload: {
          refund: {
            entity: {
              id: "rfnd_rzp_1",
              payment_id: "pay_rzp_ref_1",
              amount: 25000,
              currency: "INR",
            },
          },
        },
      };

      const result = normalizeRazorpayEvent(rzpEvent);
      expect(result.eventType).toBe("payment.refunded");
      expect(result.projections.payment?.status).toBe("REFUNDED");
      expect(result.projections.payment?.providerPaymentId).toBe("pay_rzp_ref_1");
    });

    it("normalizes invoice.paid to invoice.paid", () => {
      const rzpEvent = {
        event: "invoice.paid",
        created_at: 1700000000,
        payload: {
          invoice: {
            entity: {
              id: "inv_rzp_1",
              invoice_number: "RZP-INV-100",
              amount: 75000,
              amount_paid: 75000,
              currency: "INR",
              customer_id: "cust_rzp_3",
            },
          },
        },
      };

      const result = normalizeRazorpayEvent(rzpEvent);
      expect(result.eventType).toBe("invoice.paid");
      expect(result.projections.invoice?.status).toBe("PAID");
    });

    it("marks unrecognized Razorpay event as UNMAPPED without throwing", () => {
      const rzpEvent = {
        event: "settlement.processed",
        created_at: 1700000000,
        payload: {
          settlement: {
            entity: {
              id: "setl_123",
            },
          },
        },
      };

      const result = normalizeRazorpayEvent(rzpEvent);
      expect(result.eventType).toBe("UNMAPPED");
      expect(result.isUnmapped).toBe(true);
      expect(result.projections.payment).toBeUndefined();
    });
  });
});
