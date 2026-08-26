export const HUMAN_TASK_STATUSES = [
  "PENDING",
  "ASSIGNED",
  "APPROVED",
  "REJECTED",
  "RESOLVED",
  "CANCELLED",
] as const;

export type HumanTaskStatus = (typeof HUMAN_TASK_STATUSES)[number];

export const HumanTaskStatus = Object.freeze(
  Object.fromEntries(HUMAN_TASK_STATUSES.map((value) => [value, value])),
) as Readonly<Record<HumanTaskStatus, HumanTaskStatus>>;
