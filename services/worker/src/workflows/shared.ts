import { defineSignal, defineQuery } from "@temporalio/workflow";

declare global {
  interface BigInt {
    toJSON(): string;
  }
}

// Ensure BigInts are JSON-serializable in workflow payloads
if (typeof BigInt !== "undefined" && !BigInt.prototype.toJSON) {
  BigInt.prototype.toJSON = function (this: bigint) {
    return this.toString();
  };
}

/**
 * Deterministic Workflow ID constructor: `recover:{caseId}` (Spec 20 §Requirements 3).
 */
export const WORKFLOW_ID = (caseId: string): string => `recover:${caseId}`;

/**
 * Standard Task Queue name across all recovery workflows.
 */
export const DEFAULT_TASK_QUEUE = "recovery-main";

/**
 * Standard Signal Names
 */
export const SIGNAL_PAUSE = "pause";
export const SIGNAL_RESUME = "resume";
export const SIGNAL_STOP = "stop";
export const SIGNAL_HUMAN_DECISION = "human-decision";

/**
 * Payload for human-decision signal.
 */
export interface HumanDecisionSignalPayload {
  taskId: string;
  approved: boolean;
  notes?: string;
  decidedBy?: string;
  decidedAt?: string;
}

/**
 * Common input passed to all recovery workflows.
 */
export interface RecoveryWorkflowInput {
  tenantId: string;
  caseId: string;
  workflowType: string;
  paymentId?: string;
  checkoutId?: string;
  invoiceId?: string;
  customerId?: string;
  amountMinor?: string;
  currency?: string;
  traceparent?: string;
  metadata?: Record<string, unknown>;
}

/**
 * State exposed via workflow query.
 */
export interface WorkflowState {
  caseId: string;
  status: "RUNNING" | "WAITING" | "PAUSED" | "STOPPED" | "COMPLETED" | "FAILED";
  isPaused: boolean;
  isStopped: boolean;
  stopReason?: string;
  currentStep?: string;
  lastDecision?: HumanDecisionSignalPayload;
}

// Signal Definitions
export const pauseSignal = defineSignal<[void]>(SIGNAL_PAUSE);
export const resumeSignal = defineSignal<[void]>(SIGNAL_RESUME);
export const stopSignal = defineSignal<[{ reason?: string }]>(SIGNAL_STOP);
export const humanDecisionSignal = defineSignal<[HumanDecisionSignalPayload]>(SIGNAL_HUMAN_DECISION);

// Query Definitions
export const workflowStateQuery = defineQuery<WorkflowState>("getState");
