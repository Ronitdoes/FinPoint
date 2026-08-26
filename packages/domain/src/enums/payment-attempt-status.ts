export const PAYMENT_ATTEMPT_STATUSES = [
  "REQUESTED",
  "SUCCEEDED",
  "FAILED",
  "UNKNOWN",
] as const;

export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

export const PaymentAttemptStatus = Object.freeze(
  Object.fromEntries(
    PAYMENT_ATTEMPT_STATUSES.map((value) => [value, value]),
  ),
) as Readonly<Record<PaymentAttemptStatus, PaymentAttemptStatus>>;
