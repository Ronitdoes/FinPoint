export const STOP_CONDITIONS = [
  "PAYMENT_SUCCEEDED",
  "OPTED_OUT",
  "MAX_RETRIES",
  "DISPUTED",
  "POLICY_STOP",
  "PROMISE_MADE",
  "MANUAL_STOP",
  "ATTRIBUTION_WINDOW_EXPIRED",
] as const;

export type StopCondition = (typeof STOP_CONDITIONS)[number];

export const StopCondition = Object.freeze(
  Object.fromEntries(STOP_CONDITIONS.map((value) => [value, value])),
) as Readonly<Record<StopCondition, StopCondition>>;
