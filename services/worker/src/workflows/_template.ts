import {
  proxyActivities,
  setHandler,
  condition,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type { RecoveryActivities } from "../activities";
import {
  STANDARD_RETRY_POLICY,
} from "../framework/retry-policies";
import {
  type RecoveryWorkflowInput,
  type WorkflowState,
  type HumanDecisionSignalPayload,
  pauseSignal,
  resumeSignal,
  stopSignal,
  humanDecisionSignal,
  workflowStateQuery,
} from "./shared";

// Proxy typed activities with standard retry options
const activities = proxyActivities<RecoveryActivities>({
  startToCloseTimeout: "30s",
  retry: STANDARD_RETRY_POLICY,
});

/**
 * Reference Recovery Workflow Template (Spec 01 §13, Spec 20 §Requirements 3 & 6).
 * Demonstrates deterministic execution, signal handlers (pause/resume/stop/human-decision),
 * time-skippable waits, checkpointed pause checks, clean cancellation unrolling, and activity proxies.
 */
export async function recoveryWorkflowTemplate(
  input: RecoveryWorkflowInput,
): Promise<{ outcome: string; stopReason?: string }> {
  const info = workflowInfo();
  const actCtx = {
    tenantId: input.tenantId,
    caseId: input.caseId,
    workflowId: info.workflowId,
    runId: info.runId,
    traceparent: input.traceparent,
  };

  // 1. Local Workflow State (Deterministic)
  let isPaused = false;
  let isStopped = false;
  let stopReason: string | undefined;
  let currentStep = "INITIALIZING";
  let lastHumanDecision: HumanDecisionSignalPayload | undefined;
  const humanDecisionResolvers = new Map<
    string,
    (val: HumanDecisionSignalPayload) => void
  >();

  // 2. Setup Signal & Query Handlers
  setHandler(pauseSignal, () => {
    isPaused = true;
  });

  setHandler(resumeSignal, () => {
    isPaused = false;
  });

  setHandler(stopSignal, (payload) => {
    isStopped = true;
    stopReason = payload?.reason ?? "STOP_SIGNAL_RECEIVED";
  });

  setHandler(humanDecisionSignal, (payload) => {
    lastHumanDecision = payload;
    const resolver = humanDecisionResolvers.get(payload.taskId);
    if (resolver) {
      resolver(payload);
      humanDecisionResolvers.delete(payload.taskId);
    }
  });

  setHandler(workflowStateQuery, (): WorkflowState => ({
    caseId: input.caseId,
    status: isStopped
      ? "STOPPED"
      : isPaused
        ? "PAUSED"
        : "RUNNING",
    isPaused,
    isStopped,
    stopReason,
    currentStep,
    lastDecision: lastHumanDecision,
  }));

  try {
    // 3. Emit Started Metric & Load Snapshot
    currentStep = "LOAD_SNAPSHOT";
    await activities.emitMetric({
      ...actCtx,
      metricName: "workflow_started_total",
      labels: { type: input.workflowType },
    });

    await activities.loadCaseSnapshot(actCtx);

    // 4. Checkpoint check: Stop or Pause
    if (isStopped) {
      await activities.stopCaseWithReason({
        ...actCtx,
        stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
      });
      return { outcome: "STOPPED", stopReason };
    }

    if (isPaused) {
      currentStep = "PAUSED_WAITING";
      await activities.markCaseWaiting({
        ...actCtx,
        reason: "Workflow paused by operator signal",
      });
      await condition(() => !isPaused || isStopped);
      if (isStopped) {
        await activities.stopCaseWithReason({
          ...actCtx,
          stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
        });
        return { outcome: "STOPPED", stopReason };
      }
      await activities.markCaseInProgress({ ...actCtx, reason: "Workflow resumed" });
    }

    // 5. Execute Action Check & Policy Re-evaluation
    currentStep = "POLICY_RECHECK";
    const policyResult = await activities.checkPolicyAgain({
      ...actCtx,
      actionType: "RETRY_PAYMENT",
      actionParams: { attempt: 1 },
      amountMinor: input.amountMinor,
      currency: input.currency,
    });

    if (!policyResult.allowed) {
      await activities.stopCaseWithReason({
        ...actCtx,
        stopReason: "POLICY_REJECTED",
        notes: policyResult.rejectionReason,
      });
      return { outcome: "STOPPED", stopReason: "POLICY_REJECTED" };
    }

    // 6. Demonstrate Time-Skipped Delay
    currentStep = "WAIT_INITIAL_DELAY";
    await sleep("100ms"); // In business workflows, this will be hours/days

    // Check again after wait
    if (isStopped) {
      await activities.stopCaseWithReason({
        ...actCtx,
        stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
      });
      return { outcome: "STOPPED", stopReason };
    }

    // 7. Complete and record recovery outcome
    currentStep = "RECORD_OUTCOME";
    await activities.recordOutcome({
      ...actCtx,
      outcome: "RECOVERED",
      recoveredAmountMinor: input.amountMinor ?? "1000",
      currency: input.currency ?? "INR",
      recoverySource: "AUTOMATED_WORKFLOW",
    });

    await activities.emitMetric({
      ...actCtx,
      metricName: "workflow_outcome_total",
      labels: { type: input.workflowType, result: "RECOVERED" },
    });

    return { outcome: "RECOVERED" };
  } catch (error: unknown) {
    // 8. Escalate unhandled workflow errors to emergency human review
    currentStep = "ESCALATED";
    const errorName = error instanceof Error ? error.name : "WorkflowExecutionError";
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    await activities.escalateWorkflowFailure({
      ...actCtx,
      errorName,
      errorMessage,
      errorStack,
      failedStep: currentStep,
    });
    throw error;
  }
}
