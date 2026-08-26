export const PAYMENT_ATTEMPT_INITIATED_BY = [
  "PROVIDER_AUTO",
  "RECOVERY_WORKFLOW",
  "MANUAL",
] as const;

export type PaymentAttemptInitiatedBy =
  (typeof PAYMENT_ATTEMPT_INITIATED_BY)[number];

export const PaymentAttemptInitiatedBy = Object.freeze(
  Object.fromEntries(
    PAYMENT_ATTEMPT_INITIATED_BY.map((value) => [value, value]),
  ),
) as Readonly<Record<PaymentAttemptInitiatedBy, PaymentAttemptInitiatedBy>>;
