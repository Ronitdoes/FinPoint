export const CHECKOUT_STATUSES = [
  "STARTED",
  "PAYMENT_STARTED",
  "COMPLETED",
  "ABANDONED",
  "EXPIRED",
] as const;

export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

export const CheckoutStatus = Object.freeze(
  Object.fromEntries(CHECKOUT_STATUSES.map((value) => [value, value])),
) as Readonly<Record<CheckoutStatus, CheckoutStatus>>;
