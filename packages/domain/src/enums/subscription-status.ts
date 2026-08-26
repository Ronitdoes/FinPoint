export const SUBSCRIPTION_STATUSES = [
  "ACTIVE",
  "PAST_DUE",
  "PAUSED",
  "CANCELLED",
  "INCOMPLETE",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SubscriptionStatus = Object.freeze(
  Object.fromEntries(
    SUBSCRIPTION_STATUSES.map((value) => [value, value]),
  ),
) as Readonly<Record<SubscriptionStatus, SubscriptionStatus>>;
