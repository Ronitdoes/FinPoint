export const HUMAN_TASK_TYPES = [
  "APPROVAL",
  "DISPUTE_REVIEW",
  "COMPLIANCE_REVIEW",
  "WORKFLOW_FAILURE",
  "GENERAL",
] as const;

export type HumanTaskType = (typeof HUMAN_TASK_TYPES)[number];

export const HumanTaskType = Object.freeze(
  Object.fromEntries(HUMAN_TASK_TYPES.map((value) => [value, value])),
) as Readonly<Record<HumanTaskType, HumanTaskType>>;
