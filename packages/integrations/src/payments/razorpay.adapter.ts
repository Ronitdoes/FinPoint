import type {
  PaymentProvider,
  RetryPaymentInput,
  RetryPaymentResult,
  CreatePaymentLinkInput,
  PaymentLinkResult,
  PaymentStatusResult,
  ProviderFee,
} from "./types";
import { mapRazorpayErrorCode } from "./types";

export interface RazorpayAdapterOptions {
  keyId?: string | null;
  keySecret?: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Razorpay Payment Adapter (Spec 01 §14, Spec 18 §Adapter specifics).
 * Encapsulates Razorpay Orders, Payments, and Payment Links APIs.
 */
export class RazorpayAdapter implements PaymentProvider {
  private readonly keyId: string | null;
  private readonly keySecret: string | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: RazorpayAdapterOptions = {}) {
    this.keyId = options.keyId ?? null;
    this.keySecret = options.keySecret ?? null;
    this.baseUrl = (options.baseUrl || "https://api.razorpay.com").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  private getAuthHeaders(): Record<string, string> {
    const creds = `${this.keyId || "rzp_test_key"}:${this.keySecret || "rzp_test_secret"}`;
    const authHeader = Buffer.from(creds).toString("base64");
    return {
      Authorization: `Basic ${authHeader}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Retries payment via Razorpay Orders API with receipt = idempotencyKey.
   * As per Spec 18, Razorpay order/link retries return ACCEPTED_ASYNC for webhook/poll resolution.
   */
  async retryPayment(input: RetryPaymentInput): Promise<RetryPaymentResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseUrl}/v1/orders`;
      const body = {
        amount: Number(input.amount),
        currency: input.currency.toUpperCase(),
        receipt: input.idempotencyKey,
        notes: {
          tenant_id: input.tenantId,
          case_id: input.caseId ?? "",
          payment_id: input.paymentId,
          attempt_number: String(input.attemptNumber),
        },
      };

      const response = await this.fetchFn(url, {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = (await response.json().catch(() => ({}))) as Record<string, any>;

      if (response.ok) {
        // If an order or recurring payment returns immediate captured payment
        if (json.status === "captured" || json.status === "paid") {
          const fee = this.extractRazorpayFee(json, input.amount, input.currency);
          return {
            status: "SUCCEEDED",
            providerReference: json.id,
            fee,
            rawResponse: json,
          };
        }

        // Razorpay order created for customer retry: returns ACCEPTED_ASYNC (Spec 18)
        return {
          status: "ACCEPTED_ASYNC",
          providerReference: json.id,
          rawResponse: json,
        };
      }

      // Handle 4xx decline / validation error
      if (response.status >= 400 && response.status < 500) {
        const errorObj = json.error || json;
        const failureCode = mapRazorpayErrorCode(
          errorObj.code,
          errorObj.description,
          errorObj.reason,
        );
        return {
          status: "FAILED",
          providerReference: json.id,
          failureCode,
          rawFailureCode: errorObj.code || errorObj.reason,
          failureMessage: errorObj.description || `Razorpay error HTTP ${response.status}`,
          rawResponse: json,
        };
      }

      // 5xx Server Error from provider
      throw new Error(`Razorpay API returned 5xx status: ${response.status}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Creates a Razorpay Payment Link with reference_id = idempotencyKey.
   */
  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseUrl}/v1/payment_links`;
      const body: Record<string, any> = {
        amount: Number(input.amount),
        currency: input.currency.toUpperCase(),
        reference_id: input.idempotencyKey,
        description: input.description || "Revenue Recovery Invoice Payment",
        customer: {
          name: input.customerId || "Customer",
          email: input.customerEmail,
          contact: input.customerPhone,
        },
      };
      if (input.expiresInMinutes) {
        const expireBy = Math.floor(Date.now() / 1000) + input.expiresInMinutes * 60;
        body.expire_by = expireBy;
      }

      const response = await this.fetchFn(url, {
        method: "POST",
        headers: this.getAuthHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const json = (await response.json().catch(() => ({}))) as Record<string, any>;

      if (!response.ok) {
        throw new Error(
          json.error?.description || `Failed to create Razorpay payment link (HTTP ${response.status})`,
        );
      }

      return {
        paymentLinkId: json.id || `plink_${Math.random().toString(36).substring(2, 9)}`,
        url: json.short_url || `https://rzp.io/i/${json.id}`,
        status: (json.status || "CREATED").toUpperCase(),
        expiresAt: json.expire_by ? new Date(json.expire_by * 1000) : undefined,
        rawResponse: json,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Queries payment status on Razorpay via Payment ID or Order ID.
   */
  async getPaymentStatus(id: string): Promise<PaymentStatusResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const isOrderId = id.startsWith("order_");
      const url = isOrderId
        ? `${this.baseUrl}/v1/orders/${encodeURIComponent(id)}/payments`
        : `${this.baseUrl}/v1/payments/${encodeURIComponent(id)}`;

      const response = await this.fetchFn(url, {
        method: "GET",
        headers: this.getAuthHeaders(),
        signal: controller.signal,
      });

      const json = (await response.json().catch(() => ({}))) as Record<string, any>;

      if (!response.ok) {
        if (response.status === 404) {
          return {
            id,
            status: "UNKNOWN",
            failureCode: "unknown_decline",
            failureMessage: "Payment not found on Razorpay",
            rawResponse: json,
          };
        }
        throw new Error(json.error?.description || `Razorpay getPaymentStatus error HTTP ${response.status}`);
      }

      // If order query returned list of items, grab latest payment
      const paymentData = Array.isArray(json.items) ? json.items[0] || {} : json;
      const statusStr = (paymentData.status || "").toLowerCase();

      if (statusStr === "captured" || statusStr === "paid") {
        const amount = paymentData.amount !== undefined ? BigInt(paymentData.amount) : undefined;
        const currency = paymentData.currency ? String(paymentData.currency).toUpperCase() : "INR";
        const fee = this.extractRazorpayFee(paymentData, amount ?? 0n, currency);
        return {
          id,
          status: "SUCCEEDED",
          amount,
          currency,
          providerReference: paymentData.id || id,
          fee,
          paidAt: paymentData.created_at ? new Date(paymentData.created_at * 1000) : new Date(),
          rawResponse: paymentData,
        };
      }

      if (statusStr === "failed") {
        const failureCode = mapRazorpayErrorCode(
          paymentData.error_code,
          paymentData.error_description,
          paymentData.error_reason,
        );
        return {
          id,
          status: "FAILED",
          providerReference: paymentData.id || id,
          failureCode,
          failureMessage: paymentData.error_description || "Payment failed on Razorpay",
          rawResponse: paymentData,
        };
      }

      if (statusStr === "authorized" || statusStr === "created") {
        return {
          id,
          status: "PENDING",
          providerReference: paymentData.id || id,
          rawResponse: paymentData,
        };
      }

      if (statusStr === "refunded") {
        return {
          id,
          status: "REFUNDED",
          providerReference: paymentData.id || id,
          rawResponse: paymentData,
        };
      }

      return {
        id,
        status: "UNKNOWN",
        providerReference: paymentData.id || id,
        rawResponse: paymentData,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private extractRazorpayFee(
    json: Record<string, any>,
    amount: bigint,
    currency: string,
  ): ProviderFee {
    if (typeof json.fee === "number") {
      return {
        amount: BigInt(json.fee),
        currency: (json.currency || currency).toUpperCase(),
      };
    }

    // Standard Razorpay rate: 2% (200 bps) + 18% GST on fee
    const baseFee = (amount * 20n) / 1000n;
    const gst = (baseFee * 18n) / 100n;
    return {
      amount: baseFee + gst,
      currency: currency.toUpperCase(),
    };
  }
}
