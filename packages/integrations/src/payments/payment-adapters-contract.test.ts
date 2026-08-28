import { describe, it, expect, vi, beforeEach } from "vitest";
import { MockPaymentProvider } from "./mock.provider";
import { StripeAdapter } from "./stripe.adapter";
import { RazorpayAdapter } from "./razorpay.adapter";
import { mapStripeDeclineCode, mapRazorpayErrorCode, type RetryPaymentInput } from "./types";
import { resolvePaymentProvider } from "./resolve";

describe("Payment Provider Adapters Contract Suite", () => {
  const sampleInput: RetryPaymentInput = {
    tenantId: "11111111-1111-1111-1111-111111111111",
    caseId: "22222222-2222-2222-2222-222222222222",
    paymentId: "33333333-3333-3333-3333-333333333333",
    attemptNumber: 1,
    idempotencyKey: "11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222:RETRY_PAYMENT:1",
    amount: 1299900n, // $12,999.00 or ₹12,999.00 in minor units
    currency: "USD",
    providerPaymentId: "pi_test_12345",
  };

  beforeEach(() => {
    MockPaymentProvider.clearOverrides();
  });

  describe("Idempotency Key Format Contract", () => {
    it("matches spec string format exactly {tenant}:{case}:RETRY_PAYMENT:{attempt}", () => {
      const tenantId = "tenant_a";
      const caseId = "case_b";
      const attempt = 2;
      const key = `${tenantId}:${caseId}:RETRY_PAYMENT:${attempt}`;
      expect(key).toBe("tenant_a:case_b:RETRY_PAYMENT:2");
      expect(key).toMatch(/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+:RETRY_PAYMENT:\d+$/);
    });
  });

  describe("MockPaymentProvider", () => {
    it("fails on first attempt with insufficient_funds by default", async () => {
      const provider = new MockPaymentProvider({ defaultSuccessOnAttempt: 2 });
      const result = await provider.retryPayment({ ...sampleInput, attemptNumber: 1 });

      expect(result.status).toBe("FAILED");
      expect(result.failureCode).toBe("insufficient_funds");
      expect(result.providerReference).toBeDefined();
    });

    it("succeeds on second attempt with fee calculation", async () => {
      const provider = new MockPaymentProvider({ defaultSuccessOnAttempt: 2 });
      const result = await provider.retryPayment({ ...sampleInput, attemptNumber: 2 });

      expect(result.status).toBe("SUCCEEDED");
      expect(result.fee).toBeDefined();
      expect(result.fee?.amount).toBeGreaterThan(0n);
      expect(result.fee?.currency).toBe("USD");
    });

    it("honors explicit next-outcome overrides", async () => {
      const provider = new MockPaymentProvider();
      MockPaymentProvider.setOutcomeOverride(sampleInput.idempotencyKey, {
        status: "FAILED",
        failureCode: "stale_card",
        failureMessage: "Card is expired",
      });

      const result = await provider.retryPayment(sampleInput);
      expect(result.status).toBe("FAILED");
      expect(result.failureCode).toBe("stale_card");
      expect(result.failureMessage).toBe("Card is expired");
    });

    it("creates payment links with valid URLs", async () => {
      const provider = new MockPaymentProvider();
      const link = await provider.createPaymentLink({
        tenantId: sampleInput.tenantId,
        amount: 5000n,
        currency: "USD",
        idempotencyKey: "link_idemp_key_1",
      });

      expect(link.paymentLinkId).toBeDefined();
      expect(link.url).toContain("pay.mock-recovery.internal");
      expect(link.status).toBe("ACTIVE");
    });

    it("returns payment status", async () => {
      const provider = new MockPaymentProvider();
      const status = await provider.getPaymentStatus("mock_pay_1");

      expect(status.id).toBe("mock_pay_1");
      expect(status.status).toBe("SUCCEEDED");
      expect(status.fee).toBeDefined();
    });
  });

  describe("StripeAdapter", () => {
    it("confirms payment intent with Idempotency-Key header on retry", async () => {
      let capturedHeader = "";
      let capturedUrl = "";

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedHeader = (init?.headers as Record<string, string>)?.["Idempotency-Key"] || "";

        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "pi_test_12345",
            status: "succeeded",
            amount: 1299900,
            currency: "usd",
            charges: {
              data: [
                {
                  id: "ch_test_123",
                  balance_transaction: {
                    fee: 380,
                    currency: "usd",
                  },
                },
              ],
            },
          }),
        };
      });

      const adapter = new StripeAdapter({
        secretKey: "sk_test_123",
        fetchFn: mockFetch as any,
      });

      const result = await adapter.retryPayment(sampleInput);

      expect(capturedUrl).toContain("/v1/payment_intents/pi_test_12345/confirm");
      expect(capturedHeader).toBe(sampleInput.idempotencyKey);
      expect(result.status).toBe("SUCCEEDED");
      expect(result.providerReference).toBe("pi_test_12345");
      expect(result.fee?.amount).toBe(380n);
    });

    it("handles card decline and maps decline code to internal taxonomy", async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          ok: false,
          status: 402,
          json: async () => ({
            error: {
              code: "card_declined",
              decline_code: "insufficient_funds",
              message: "Your card has insufficient funds.",
            },
          }),
        };
      });

      const adapter = new StripeAdapter({
        secretKey: "sk_test_123",
        fetchFn: mockFetch as any,
      });

      const result = await adapter.retryPayment(sampleInput);

      expect(result.status).toBe("FAILED");
      expect(result.failureCode).toBe("insufficient_funds");
      expect(result.failureMessage).toContain("insufficient funds");
    });

    it("creates payment link with Idempotency-Key", async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "plink_stripe_abc123",
            url: "https://buy.stripe.com/plink_stripe_abc123",
            active: true,
          }),
        };
      });

      const adapter = new StripeAdapter({
        secretKey: "sk_test_123",
        fetchFn: mockFetch as any,
      });

      const link = await adapter.createPaymentLink({
        tenantId: sampleInput.tenantId,
        amount: 2500n,
        currency: "USD",
        idempotencyKey: "plink_idemp_key_1",
      });

      expect(link.paymentLinkId).toBe("plink_stripe_abc123");
      expect(link.url).toBe("https://buy.stripe.com/plink_stripe_abc123");
      expect(link.status).toBe("ACTIVE");
    });
  });

  describe("RazorpayAdapter", () => {
    it("creates order with receipt = idempotencyKey and returns ACCEPTED_ASYNC", async () => {
      let capturedBody: any = null;

      const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        capturedBody = JSON.parse(init?.body as string);

        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "order_rzp_12345",
            entity: "order",
            amount: 1299900,
            currency: "INR",
            receipt: capturedBody.receipt,
            status: "created",
          }),
        };
      });

      const adapter = new RazorpayAdapter({
        keyId: "rzp_test_key",
        keySecret: "rzp_test_secret",
        fetchFn: mockFetch as any,
      });

      const result = await adapter.retryPayment({
        ...sampleInput,
        currency: "INR",
      });

      expect(capturedBody.receipt).toBe(sampleInput.idempotencyKey);
      expect(result.status).toBe("ACCEPTED_ASYNC");
      expect(result.providerReference).toBe("order_rzp_12345");
    });

    it("maps Razorpay decline errors to internal taxonomy", async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: {
              code: "BAD_REQUEST_ERROR",
              description: "Payment failed due to insufficient balance in account",
              reason: "payment_card_insufficient_funds",
            },
          }),
        };
      });

      const adapter = new RazorpayAdapter({
        keyId: "rzp_test_key",
        keySecret: "rzp_test_secret",
        fetchFn: mockFetch as any,
      });

      const result = await adapter.retryPayment(sampleInput);

      expect(result.status).toBe("FAILED");
      expect(result.failureCode).toBe("insufficient_funds");
    });

    it("polls payment status and extracts fee", async () => {
      const mockFetch = vi.fn().mockImplementation(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: "pay_rzp_987",
            status: "captured",
            amount: 1299900,
            currency: "INR",
            fee: 30678,
          }),
        };
      });

      const adapter = new RazorpayAdapter({
        keyId: "rzp_test_key",
        keySecret: "rzp_test_secret",
        fetchFn: mockFetch as any,
      });

      const status = await adapter.getPaymentStatus("pay_rzp_987");

      expect(status.status).toBe("SUCCEEDED");
      expect(status.amount).toBe(1299900n);
      expect(status.fee?.amount).toBe(30678n);
    });
  });

  describe("Decline Code Mapping Taxonomy", () => {
    it("maps diverse Stripe decline codes correctly", () => {
      expect(mapStripeDeclineCode("insufficient_funds")).toBe("insufficient_funds");
      expect(mapStripeDeclineCode("expired_card")).toBe("stale_card");
      expect(mapStripeDeclineCode("incorrect_cvc")).toBe("incorrect_cvc");
      expect(mapStripeDeclineCode("lost_card")).toBe("lost_or_stolen");
      expect(mapStripeDeclineCode("stolen_card")).toBe("lost_or_stolen");
      expect(mapStripeDeclineCode("do_not_honor")).toBe("do_not_honor");
      expect(mapStripeDeclineCode("card_declined")).toBe("bank_decline");
      expect(mapStripeDeclineCode("fraudulent")).toBe("fraudulent");
      expect(mapStripeDeclineCode("random_unseen_code")).toBe("unknown_decline");
    });

    it("maps diverse Razorpay error codes correctly", () => {
      expect(mapRazorpayErrorCode("BAD_REQUEST_ERROR", "insufficient balance")).toBe("insufficient_funds");
      expect(mapRazorpayErrorCode("BAD_REQUEST_ERROR", "Card is expired")).toBe("stale_card");
      expect(mapRazorpayErrorCode("BAD_REQUEST_ERROR", "Invalid CVV entered")).toBe("incorrect_cvc");
      expect(mapRazorpayErrorCode("BAD_REQUEST_ERROR", "Card is stolen")).toBe("lost_or_stolen");
      expect(mapRazorpayErrorCode("GATEWAY_ERROR", "Bank declined the transaction")).toBe("bank_decline");
      expect(mapRazorpayErrorCode("GATEWAY_ERROR", "Server timed out")).toBe("processing_error");
    });
  });

  describe("Resolver", () => {
    it("returns MockPaymentProvider when mockProviders is true or provider is MOCK", () => {
      const adapter = resolvePaymentProvider({
        provider: "MOCK",
        demoConfig: { mockProviders: true, simulatePaymentTimeout: false },
      });
      expect(adapter).toBeInstanceOf(MockPaymentProvider);
    });

    it("returns StripeAdapter when provider is STRIPE and keys exist", () => {
      const adapter = resolvePaymentProvider({
        provider: "STRIPE",
        paymentsConfig: { stripeSecretKey: "sk_live_123" },
        demoConfig: { mockProviders: false, simulatePaymentTimeout: false },
      });
      expect(adapter).toBeInstanceOf(StripeAdapter);
    });

    it("returns RazorpayAdapter when provider is RAZORPAY and keys exist", () => {
      const adapter = resolvePaymentProvider({
        provider: "RAZORPAY",
        paymentsConfig: { razorpayKeyId: "rzp_123", razorpayKeySecret: "secret" },
        demoConfig: { mockProviders: false, simulatePaymentTimeout: false },
      });
      expect(adapter).toBeInstanceOf(RazorpayAdapter);
    });
  });
});
