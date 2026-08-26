export const WORKFLOW_STATUSES = [
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "CONTINUED_AS_NEW",
] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WorkflowStatus = Object.freeze(
  Object.fromEntries(WORKFLOW_STATUSES.map((value) => [value, value])),
) as Readonly<Record<WorkflowStatus, WorkflowStatus>>;
