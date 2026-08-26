export const CASE_STATUSES = [
  "DETECTED",
  "QUALIFIED",
  "DECISION_PENDING",
  "POLICY_REVIEW",
  "IN_PROGRESS",
  "WAITING",
  "RECOVERED",
  "STOPPED",
  "ESCALATED",
  "FAILED",
] as const;

export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CaseStatus = Object.freeze(
  Object.fromEntries(CASE_STATUSES.map((value) => [value, value])),
) as Readonly<Record<CaseStatus, CaseStatus>>;
