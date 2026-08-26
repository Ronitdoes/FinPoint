export const PAYMENT_STATUSES = [
  "CREATED",
  "PENDING",
  "FAILED",
  "SUCCEEDED",
  "REFUNDED",
  "DISPUTED",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PaymentStatus = Object.freeze(
  Object.fromEntries(PAYMENT_STATUSES.map((value) => [value, value])),
) as Readonly<Record<PaymentStatus, PaymentStatus>>;
