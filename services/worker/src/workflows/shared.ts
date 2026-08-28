import { defineSignal, defineQuery, condition } from "@temporalio/workflow";

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
export const SIGNAL_EXTERNAL_PAYMENT_SUCCEEDED = "external-payment-succeeded";
export const SIGNAL_EXTERNAL_CHECKOUT_COMPLETED = "external-checkout-completed";

/**
 * Payload for external-payment-succeeded signal.
 */
export interface ExternalPaymentSucceededPayload {
  paymentId?: string;
  amount?: string | number;
  currency?: string;
  paidAt?: string;
  [key: string]: unknown;
}

/**
 * Payload for external-checkout-completed signal.
 */
export interface ExternalCheckoutCompletedPayload {
  checkoutId?: string;
  completedAt?: string;
  paymentId?: string;
  amount?: string | number;
  currency?: string;
  [key: string]: unknown;
}

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
  retryCount?: number;
}

// Signal Definitions
export const pauseSignal = defineSignal<[void]>(SIGNAL_PAUSE);
export const resumeSignal = defineSignal<[void]>(SIGNAL_RESUME);
export const stopSignal = defineSignal<[{ reason?: string }]>(SIGNAL_STOP);
export const humanDecisionSignal = defineSignal<[HumanDecisionSignalPayload]>(SIGNAL_HUMAN_DECISION);
export const externalPaymentSucceededSignal = defineSignal<[ExternalPaymentSucceededPayload]>(SIGNAL_EXTERNAL_PAYMENT_SUCCEEDED);
export const externalCheckoutCompletedSignal = defineSignal<[ExternalCheckoutCompletedPayload]>(SIGNAL_EXTERNAL_CHECKOUT_COMPLETED);

// Query Definitions
export const workflowStateQuery = defineQuery<WorkflowState>("getState");

export interface HumanApprovalOutcome {
  taskId: string;
  approved: boolean;
  notes?: string;
  decidedBy?: string;
  decidedAt?: string;
  recoveredViaFallback: boolean;
}

/**
 * Workflow waiting primitive: awaits human decision signal with 60s crash-recovery DB check fallback (Step 21).
 * Event-driven first (instant signal wakeup), falling back to polling activity only on missed signals or worker restarts.
 */
export async function awaitHumanApproval(
  actCtx: { tenantId: string; caseId: string; [key: string]: unknown },
  taskId: string,
  activities: {
    waitForHumanDecision: (input: {
      tenantId: string;
      caseId: string;
      taskId: string;
      [key: string]: unknown;
    }) => Promise<{
      taskId: string;
      status: string;
      approved: boolean;
      decidedBy?: string;
      decisionNotes?: string;
      decidedAt?: string;
    }>;
  },
  getDecision: () => HumanDecisionSignalPayload | undefined,
  heartbeatInterval: string = "60s",
): Promise<HumanApprovalOutcome> {
  // 1. Check if decision signal already arrived
  const immediate = getDecision();
  if (immediate && immediate.taskId === taskId) {
    return {
      taskId,
      approved: immediate.approved,
      notes: immediate.notes,
      decidedBy: immediate.decidedBy,
      decidedAt: immediate.decidedAt,
      recoveredViaFallback: false,
    };
  }

  // 2. Condition loop with heartbeat fallback
  while (true) {
    const signaled = await condition(() => {
      const d = getDecision();
      return d !== undefined && d.taskId === taskId;
    }, heartbeatInterval);

    if (signaled) {
      const decision = getDecision()!;
      return {
        taskId,
        approved: decision.approved,
        notes: decision.notes,
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
        recoveredViaFallback: false,
      };
    }

    // 3. Fallback recovery: check DB status in case signal was lost during worker restart
    try {
      const dbTask = await activities.waitForHumanDecision({
        ...actCtx,
        taskId,
      });

      if (dbTask.status === "APPROVED" || dbTask.status === "RESOLVED") {
        return {
          taskId,
          approved: true,
          notes: dbTask.decisionNotes,
          decidedBy: dbTask.decidedBy,
          decidedAt: dbTask.decidedAt,
          recoveredViaFallback: true,
        };
      } else if (dbTask.status === "REJECTED" || dbTask.status === "CANCELLED") {
        return {
          taskId,
          approved: false,
          notes: dbTask.decisionNotes,
          decidedBy: dbTask.decidedBy,
          decidedAt: dbTask.decidedAt,
          recoveredViaFallback: true,
        };
      }
    } catch {
      // transient activity error; continue waiting in condition loop
    }
  }
}

