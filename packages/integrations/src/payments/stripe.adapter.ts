import type {
  PaymentProvider,
  RetryPaymentInput,
  RetryPaymentResult,
  CreatePaymentLinkInput,
  PaymentLinkResult,
  PaymentStatusResult,
  ProviderFee,
} from "./types";
import { mapStripeDeclineCode } from "./types";

export interface StripeAdapterOptions {
  secretKey?: string | null;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Stripe Payment Adapter (Spec 01 §14, Spec 18 §Adapter specifics).
 * Encapsulates all Stripe REST API interactions. Pass-through for Idempotency-Key headers.
 */
export class StripeAdapter implements PaymentProvider {
  private readonly secretKey: string | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: StripeAdapterOptions = {}) {
    this.secretKey = options.secretKey ?? null;
    this.baseUrl = (options.baseUrl || "https://api.stripe.com").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  private getAuthHeaders(idempotencyKey?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey || "sk_test_placeholder"}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }
    return headers;
  }

  /**
   * Retries a payment via Stripe PaymentIntent confirm API with Idempotency-Key header.
   */
  async retryPayment(input: RetryPaymentInput): Promise<RetryPaymentResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const isExistingIntent = !!input.providerPaymentId && input.providerPaymentId.startsWith("pi_");
      const url = isExistingIntent
        ? `${this.baseUrl}/v1/payment_intents/${input.providerPaymentId}/confirm`
        : `${this.baseUrl}/v1/payment_intents`;

      const params = new URLSearchParams();
      if (!isExistingIntent) {
        params.append("amount", input.amount.toString());
        params.append("currency", input.currency.toLowerCase());
        params.append("confirm", "true");
        params.append("off_session", "true");
        if (input.paymentMethodId) {
          params.append("payment_method", input.paymentMethodId);
        }
        if (input.customerId) {
          params.append("customer", input.customerId);
        }
      } else {
        params.append("off_session", "true");
        if (input.paymentMethodId) {
          params.append("payment_method", input.paymentMethodId);
        }
      }

      const response = await this.fetchFn(url, {
        method: "POST",
        headers: this.getAuthHeaders(input.idempotencyKey),
        body: params.toString(),
        signal: controller.signal,
      });

      const responseJson = (await response.json().catch(() => ({}))) as Record<string, any>;

      if (response.ok) {
        const intentStatus = responseJson.status;
        if (intentStatus === "succeeded") {
          const fee = this.extractStripeFee(responseJson, input.amount, input.currency);
          return {
            status: "SUCCEEDED",
            providerReference: responseJson.id || input.providerPaymentId,
            fee,
            rawResponse: responseJson,
          };
        }

        if (intentStatus === "processing") {
          return {
            status: "ACCEPTED_ASYNC",
            providerReference: responseJson.id || input.providerPaymentId,
            rawResponse: responseJson,
          };
        }

        // Requires action / payment method with error
        const lastError = responseJson.last_payment_error;
        const failureCode = mapStripeDeclineCode(lastError?.decline_code, lastError?.code);
        return {
          status: "FAILED",
          providerReference: responseJson.id || input.providerPaymentId,
          failureCode,
          rawFailureCode: lastError?.decline_code || lastError?.code || intentStatus,
          failureMessage: lastError?.message || `PaymentIntent status: ${intentStatus}`,
          rawResponse: responseJson,
        };
      }

      // Handle HTTP error (e.g. 402 Card Error, 400 Bad Request)
      if (response.status >= 400 && response.status < 500) {
        const errObj = responseJson.error || responseJson;
        const failureCode = mapStripeDeclineCode(errObj.decline_code, errObj.code);
        return {
          status: "FAILED",
          providerReference: responseJson.id || input.providerPaymentId,
          failureCode,
          rawFailureCode: errObj.decline_code || errObj.code,
          failureMessage: errObj.message || `Stripe error HTTP ${response.status}`,
          rawResponse: responseJson,
        };
      }

      // 5xx Server Error from provider
      throw new Error(`Stripe API returned 5xx status: ${response.status}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Creates a Stripe Payment Link.
   */
  async createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseUrl}/v1/payment_links`;
      const params = new URLSearchParams();
      // Line item parameters for Stripe Payment Link
      params.append("line_items[0][price_data][currency]", input.currency.toLowerCase());
      params.append("line_items[0][price_data][unit_amount]", input.amount.toString());
      params.append("line_items[0][price_data][product_data][name]", input.description || "Invoice Payment");
      params.append("line_items[0][quantity]", "1");

      const response = await this.fetchFn(url, {
        method: "POST",
        headers: this.getAuthHeaders(input.idempotencyKey),
        body: params.toString(),
        signal: controller.signal,
      });

      const json = (await response.json().catch(() => ({}))) as Record<string, any>;

      if (!response.ok) {
        throw new Error(json.error?.message || `Failed to create Stripe payment link (HTTP ${response.status})`);
      }

      return {
        paymentLinkId: json.id || `plink_${Math.random().toString(36).substring(2, 9)}`,
        url: json.url || `https://buy.stripe.com/${json.id}`,
        status: json.active ? "ACTIVE" : "INACTIVE",
        rawResponse: json,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Queries the live status of a PaymentIntent on Stripe.
   */
  async getPaymentStatus(id: string): Promise<PaymentStatusResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const url = `${this.baseUrl}/v1/payment_intents/${encodeURIComponent(id)}`;
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
            failureMessage: "PaymentIntent not found on Stripe",
            rawResponse: json,
          };
        }
        throw new Error(json.error?.message || `Stripe getPaymentStatus error HTTP ${response.status}`);
      }

      const stripeStatus = json.status;
      if (stripeStatus === "succeeded") {
        const amount = json.amount !== undefined ? BigInt(json.amount) : undefined;
        const currency = json.currency ? String(json.currency).toUpperCase() : "USD";
        const fee = this.extractStripeFee(json, amount ?? 0n, currency);
        return {
          id,
          status: "SUCCEEDED",
          amount,
          currency,
          providerReference: json.id,
          fee,
          paidAt: json.created ? new Date(json.created * 1000) : new Date(),
          rawResponse: json,
        };
      }

      if (stripeStatus === "canceled") {
        const lastError = json.last_payment_error;
        return {
          id,
          status: "FAILED",
          providerReference: json.id,
          failureCode: mapStripeDeclineCode(lastError?.decline_code, lastError?.code),
          failureMessage: lastError?.message || json.cancellation_reason || "PaymentIntent canceled",
          rawResponse: json,
        };
      }

      if (stripeStatus === "requires_payment_method" && json.last_payment_error) {
        const lastError = json.last_payment_error;
        return {
          id,
          status: "FAILED",
          providerReference: json.id,
          failureCode: mapStripeDeclineCode(lastError?.decline_code, lastError?.code),
          failureMessage: lastError?.message || "Payment method failed",
          rawResponse: json,
        };
      }

      if (stripeStatus === "processing" || stripeStatus === "requires_action") {
        return {
          id,
          status: "PENDING",
          providerReference: json.id,
          rawResponse: json,
        };
      }

      return {
        id,
        status: "UNKNOWN",
        providerReference: json.id,
        rawResponse: json,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private extractStripeFee(
    responseJson: Record<string, any>,
    amount: bigint,
    currency: string,
  ): ProviderFee {
    // Check if charges contain balance transaction fee
    if (
      responseJson.charges?.data?.[0]?.balance_transaction &&
      typeof responseJson.charges.data[0].balance_transaction === "object"
    ) {
      const bt = responseJson.charges.data[0].balance_transaction;
      if (typeof bt.fee === "number") {
        return {
          amount: BigInt(bt.fee),
          currency: (bt.currency || currency).toUpperCase(),
        };
      }
    }

    if (typeof responseJson.fee === "number") {
      return {
        amount: BigInt(responseJson.fee),
        currency: (responseJson.fee_currency || currency).toUpperCase(),
      };
    }

    // Standard Stripe interchange fee estimate: 2.9% + 30 cents (or minor units equivalent)
    const variableFee = (amount * 29n) / 1000n;
    const fixedFee = currency.toUpperCase() === "USD" ? 30n : 200n; // 30 cents or 200 paise
    return {
      amount: variableFee + fixedFee,
      currency: currency.toUpperCase(),
    };
  }
}
