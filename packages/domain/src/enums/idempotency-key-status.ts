export const IDEMPOTENCY_KEY_STATUSES = [
  "PROCESSING",
  "COMPLETED",
  "FAILED",
] as const;

export type IdempotencyKeyStatus = (typeof IDEMPOTENCY_KEY_STATUSES)[number];

export const IdempotencyKeyStatus = Object.freeze(
  Object.fromEntries(IDEMPOTENCY_KEY_STATUSES.map((value) => [value, value])),
) as Readonly<Record<IdempotencyKeyStatus, IdempotencyKeyStatus>>;
