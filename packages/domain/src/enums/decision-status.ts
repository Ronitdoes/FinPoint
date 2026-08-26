export const DECISION_STATUSES = [
  "COMPLETED",
  "INVALID_OUTPUT",
  "FALLBACK_RULE_BASED",
  "FAILED",
  "POLICY_REJECTED",
] as const;

export type DecisionStatus = (typeof DECISION_STATUSES)[number];

export const DecisionStatus = Object.freeze(
  Object.fromEntries(DECISION_STATUSES.map((value) => [value, value])),
) as Readonly<Record<DecisionStatus, DecisionStatus>>;
