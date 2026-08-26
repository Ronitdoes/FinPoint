export const PROMISE_TO_PAY_STATUSES = [
  "MADE",
  "HONORED",
  "BROKEN",
  "EXPIRED",
] as const;

export type PromiseToPayStatus = (typeof PROMISE_TO_PAY_STATUSES)[number];

export const PromiseToPayStatus = Object.freeze(
  Object.fromEntries(PROMISE_TO_PAY_STATUSES.map((value) => [value, value])),
) as Readonly<Record<PromiseToPayStatus, PromiseToPayStatus>>;
