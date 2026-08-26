export const ACTION_STATUSES = [
  "PROPOSED",
  "APPROVAL_REQUIRED",
  "APPROVED",
  "POLICY_REJECTED",
  "EXECUTING",
  "EXECUTED",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
] as const;

export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ActionStatus = Object.freeze(
  Object.fromEntries(ACTION_STATUSES.map((value) => [value, value])),
) as Readonly<Record<ActionStatus, ActionStatus>>;
