export const HUMAN_TASK_PRIORITIES = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "URGENT",
] as const;

export type HumanTaskPriority = (typeof HUMAN_TASK_PRIORITIES)[number];

export const HumanTaskPriority = Object.freeze(
  Object.fromEntries(HUMAN_TASK_PRIORITIES.map((value) => [value, value])),
) as Readonly<Record<HumanTaskPriority, HumanTaskPriority>>;
