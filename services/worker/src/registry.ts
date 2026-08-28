import { activities, type RecoveryActivities } from "./activities";
import { recoveryWorkflowTemplate } from "./workflows/_template";

/**
 * Registry of all available Temporal Workflows in the recovery worker.
 */
export const WORKFLOWS = {
  recoveryWorkflowTemplate,
} as const;

/**
 * Registry of all available Temporal Activities.
 */
export const ACTIVITIES: RecoveryActivities = activities;

export type RegisteredWorkflowName = keyof typeof WORKFLOWS;
export type RegisteredActivityName = keyof typeof ACTIVITIES;
