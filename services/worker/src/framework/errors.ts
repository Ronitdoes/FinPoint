import { ApplicationFailure } from "@temporalio/common";

/**
 * Standard error codes that short-circuit Temporal activity retry policies.
 * (Spec 01 §21, Spec 20 §Requirements 4).
 */
export const NON_RETRYABLE_ERROR_TYPES = [
  "VALIDATION_FAILED",
  "POLICY_REJECTED",
  "TERMINAL_DECLINE",
  "CUSTOMER_OPTED_OUT",
  "ENTITY_NOT_FOUND",
  "ILLEGAL_TRANSITION",
  "AUTHENTICATION_FAILED",
  "TERMINAL_PROVIDER_ERROR",
] as const;

export type NonRetryableErrorType = (typeof NON_RETRYABLE_ERROR_TYPES)[number];

/**
 * Creates a non-retryable Temporal ApplicationFailure.
 */
export function createNonRetryableFailure(
  message: string,
  type: NonRetryableErrorType | string = "NON_RETRYABLE",
  details: unknown[] = [],
): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, type, ...details);
}

/**
 * Thrown when an activity encounters a policy rejection that cannot be bypassed.
 */
export class PolicyRejectionError extends Error {
  readonly code = "POLICY_REJECTED";
  constructor(message: string, readonly policyId?: string, readonly reason?: string) {
    super(message);
    this.name = "PolicyRejectionError";
  }

  toApplicationFailure(): ApplicationFailure {
    return ApplicationFailure.nonRetryable(
      this.message,
      "POLICY_REJECTED",
      this.policyId,
      this.reason,
    );
  }
}

/**
 * Thrown when a payment or messaging provider issues an unrecoverable terminal error
 * (e.g. invalid card number, closed bank account, unroutable phone number).
 */
export class TerminalProviderError extends Error {
  readonly code = "TERMINAL_PROVIDER_ERROR";
  constructor(
    message: string,
    readonly provider: string,
    readonly declineCode?: string,
  ) {
    super(message);
    this.name = "TerminalProviderError";
  }

  toApplicationFailure(): ApplicationFailure {
    return ApplicationFailure.nonRetryable(
      this.message,
      "TERMINAL_DECLINE",
      this.provider,
      this.declineCode,
    );
  }
}

/**
 * Thrown when input validation fails in an activity.
 */
export class ValidationFailureError extends Error {
  readonly code = "VALIDATION_FAILED";
  constructor(message: string, readonly fields?: Record<string, string>) {
    super(message);
    this.name = "ValidationFailureError";
  }

  toApplicationFailure(): ApplicationFailure {
    return ApplicationFailure.nonRetryable(
      this.message,
      "VALIDATION_FAILED",
      this.fields,
    );
  }
}

/**
 * Thrown when attempting to contact an opted-out customer.
 */
export class CustomerOptedOutFailure extends Error {
  readonly code = "CUSTOMER_OPTED_OUT";
  constructor(customerId: string) {
    super(`Customer '${customerId}' has opted out of communications`);
    this.name = "CustomerOptedOutFailure";
  }

  toApplicationFailure(): ApplicationFailure {
    return ApplicationFailure.nonRetryable(
      this.message,
      "CUSTOMER_OPTED_OUT",
    );
  }
}
