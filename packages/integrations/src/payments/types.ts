import type { Provider } from "@repo/domain";

/**
 * Closed taxonomy of internal decline codes for uniform failure classification.
 * Spec 18 §Adapter specifics & §Observability.
 */
export const INTERNAL_DECLINE_CODES = [
  "insufficient_funds",
  "stale_card",
  "bank_decline",
  "do_not_honor",
  "incorrect_cvc",
  "lost_or_stolen",
  "fraudulent",
  "invalid_account",
  "processing_error",
  "unknown_decline",
] as const;

export type InternalDeclineCode = (typeof INTERNAL_DECLINE_CODES)[number];

export type RetryPaymentStatus =
  | "SUCCEEDED"
  | "FAILED"
  | "UNKNOWN"
  | "ACCEPTED_ASYNC";

export interface ProviderFee {
  amount: bigint;
  currency: string;
}

export interface RetryPaymentInput {
  tenantId: string;
  caseId?: string;
  paymentId: string;
  attemptNumber: number;
  idempotencyKey: string;
  amount: bigint;
  currency: string;
  providerPaymentId?: string;
  paymentMethodId?: string;
  customerId?: string;
  customerEmail?: string;
  metadata?: Record<string, unknown>;
}

export interface RetryPaymentResult {
  status: RetryPaymentStatus;
  providerReference?: string;
  failureCode?: InternalDeclineCode | string;
  rawFailureCode?: string;
  failureMessage?: string;
  fee?: ProviderFee;
  rawResponse?: Record<string, unknown>;
}

export interface CreatePaymentLinkInput {
  tenantId: string;
  caseId?: string;
  paymentId?: string;
  amount: bigint;
  currency: string;
  customerId?: string;
  customerEmail?: string;
  customerPhone?: string;
  idempotencyKey: string;
  description?: string;
  expiresInMinutes?: number;
  metadata?: Record<string, unknown>;
}

export interface PaymentLinkResult {
  paymentLinkId: string;
  url: string;
  status: "ACTIVE" | "PAID" | "EXPIRED" | "CREATED" | string;
  expiresAt?: Date;
  rawResponse?: Record<string, unknown>;
}

export interface PaymentStatusResult {
  id: string;
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "PENDING" | "CREATED" | "REFUNDED" | "DISPUTED";
  amount?: bigint;
  currency?: string;
  providerReference?: string;
  failureCode?: InternalDeclineCode | string;
  failureMessage?: string;
  fee?: ProviderFee;
  paidAt?: Date;
  rawResponse?: Record<string, unknown>;
}

export type PaymentStatus = PaymentStatusResult;

/**
 * Standard Payment Provider interface contract (Spec 01 §14, Spec 18 §Requirements 1).
 */
export interface PaymentProvider {
  retryPayment(input: RetryPaymentInput): Promise<RetryPaymentResult>;
  createPaymentLink(input: CreatePaymentLinkInput): Promise<PaymentLinkResult>;
  getPaymentStatus(id: string): Promise<PaymentStatusResult>;
}

/**
 * Maps Stripe raw decline codes / error codes to internal decline taxonomy.
 */
export function mapStripeDeclineCode(
  declineCode?: string | null,
  errorCode?: string | null,
): InternalDeclineCode {
  const code = (declineCode || errorCode || "").toLowerCase().trim();

  switch (code) {
    case "insufficient_funds":
      return "insufficient_funds";
    case "expired_card":
      return "stale_card";
    case "incorrect_cvc":
    case "invalid_cvc":
      return "incorrect_cvc";
    case "lost_card":
    case "stolen_card":
      return "lost_or_stolen";
    case "do_not_honor":
      return "do_not_honor";
    case "generic_decline":
    case "card_declined":
    case "bank_decline":
    case "withdrawal_count_limit_exceeded":
      return "bank_decline";
    case "fraudulent":
    case "merchant_blacklist":
      return "fraudulent";
    case "invalid_account":
    case "incorrect_number":
    case "invalid_number":
      return "invalid_account";
    case "processing_error":
    case "card_velocity_exceeded":
      return "processing_error";
    default:
      return "unknown_decline";
  }
}

/**
 * Maps Razorpay error codes / error reasons to internal decline taxonomy.
 */
export function mapRazorpayErrorCode(
  errorCode?: string | null,
  description?: string | null,
  reason?: string | null,
): InternalDeclineCode {
  const text = `${errorCode || ""} ${description || ""} ${reason || ""}`.toLowerCase().trim();

  if (text.includes("insufficient_funds") || text.includes("insufficient balance") || text.includes("low balance")) {
    return "insufficient_funds";
  }
  if (text.includes("expired") || text.includes("expiry")) {
    return "stale_card";
  }
  if (text.includes("invalid_cvv") || text.includes("incorrect_cvc") || text.includes("cvv")) {
    return "incorrect_cvc";
  }
  if (text.includes("lost_card") || text.includes("stolen")) {
    return "lost_or_stolen";
  }
  if (
    text.includes("do_not_honor") ||
    text.includes("declined by bank") ||
    text.includes("bank declined") ||
    text.includes("bank_error") ||
    (text.includes("bank") && text.includes("decline"))
  ) {
    return "bank_decline";
  }
  if (text.includes("fraud") || text.includes("risk_check")) {
    return "fraudulent";
  }
  if (text.includes("invalid_account") || text.includes("invalid_card")) {
    return "invalid_account";
  }
  if (text.includes("gateway_error") || text.includes("server_error") || text.includes("processing_error")) {
    return "processing_error";
  }
  return "unknown_decline";
}
