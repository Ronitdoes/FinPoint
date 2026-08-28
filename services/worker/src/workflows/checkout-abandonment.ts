import {
  proxyActivities,
  setHandler,
  condition,
  workflowInfo,
} from "@temporalio/workflow";
import type { RecoveryActivities } from "../activities";
import { STANDARD_RETRY_POLICY } from "../framework/retry-policies";
import {
  type RecoveryWorkflowInput,
  type WorkflowState,
  type HumanDecisionSignalPayload,
  type ExternalCheckoutCompletedPayload,
  type ExternalPaymentSucceededPayload,
  pauseSignal,
  resumeSignal,
  stopSignal,
  humanDecisionSignal,
  externalCheckoutCompletedSignal,
  externalPaymentSucceededSignal,
  workflowStateQuery,
  awaitHumanApproval,
} from "./shared";

// Proxy typed activities with standard retry options
const activities = proxyActivities<RecoveryActivities>({
  startToCloseTimeout: "30s",
  retry: STANDARD_RETRY_POLICY,
});

/**
 * Workflow B: Checkout Abandonment Workflow (Spec 00 Surface 2, Spec 01 §15, Spec 23).
 * Durable sequence:
 *   WATCH(timer) → confirm abandonment → risk/context/AI/policy → Touch 1 Reminder (zero discount)
 *   → wait(4h) → purchase check → Touch 2 Incentive (if policy approved) → wait(24h) → final check → stop/recovered.
 *
 * Implements strict first-touch zero-discount invariant, completion race guards before every send,
 * silent exit on early completion without case creation, and instant signal-driven completion.
 */
export async function checkoutAbandonmentWorkflow(
  input: RecoveryWorkflowInput,
): Promise<{
  outcome: string;
  stage?: string;
  stopReason?: string;
  caseId?: string;
  recoveredAmountMinor?: string;
  checkoutId?: string;
}> {
  const info = workflowInfo();
  const checkoutId = (input.checkoutId ?? input.caseId)!;
  let effectiveCaseId = input.caseId ?? checkoutId;

  const actCtx = {
    tenantId: input.tenantId,
    caseId: effectiveCaseId,
    workflowId: info.workflowId,
    runId: info.runId,
    traceparent: input.traceparent,
  };

  // 1. Local Workflow State (Deterministic)
  let isPaused = false;
  let isStopped = false;
  let stopReason: string | undefined;
  let checkoutCompleted = false;
  let completionPayload: ExternalCheckoutCompletedPayload | undefined;
  let lastHumanDecision: HumanDecisionSignalPayload | undefined;
  const humanDecisionResolvers = new Map<
    string,
    (val: HumanDecisionSignalPayload) => void
  >();
  let currentStep = "INITIALIZING";

  // 2. Setup Signal Handlers
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

  setHandler(externalCheckoutCompletedSignal, (payload) => {
    checkoutCompleted = true;
    completionPayload = payload;
  });

  setHandler(externalPaymentSucceededSignal, (payload: ExternalPaymentSucceededPayload) => {
    checkoutCompleted = true;
    completionPayload = {
      checkoutId,
      paymentId: payload.paymentId,
      amount: payload.amount,
      currency: payload.currency,
      completedAt: payload.paidAt,
    };
  });

  // 3. Setup Query Handler
  setHandler(workflowStateQuery, (): WorkflowState => ({
    caseId: effectiveCaseId,
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
    // =========================================================================
    // PHASE 1: WATCH & INACTIVITY TIMER (s-23 §Requirements 1 & 2)
    // =========================================================================
    currentStep = "WATCHING_INACTIVITY_TIMER";
    await activities.emitMetric({
      ...actCtx,
      metricName: "workflow_started_total",
      labels: { type: "CheckoutAbandonmentWorkflow" },
    });

    const inactivityDelay = (input.metadata?.inactivityDelay as string) ?? "30m";

    // Wait for inactivity timer to fire OR early checkout completion / stop signal
    await condition(
      () => checkoutCompleted || isStopped,
      inactivityDelay,
    );

    // If purchase completed before abandonment timer expired -> exit silently with NO case created
    if (checkoutCompleted) {
      currentStep = "COMPLETED_BEFORE_ABANDONMENT";
      await activities.emitMetric({
        ...actCtx,
        metricName: "workflow_outcome_total",
        labels: { type: "CheckoutAbandonmentWorkflow", result: "COMPLETED_SILENTLY" },
      });
      return {
        outcome: "COMPLETED_BEFORE_ABANDONMENT",
        stage: "WATCH_TIMER",
        checkoutId,
      };
    }

    if (isStopped) {
      currentStep = "STOPPED_BEFORE_ABANDONMENT";
      return {
        outcome: "STOPPED",
        stopReason,
        stage: "WATCH_TIMER",
        checkoutId,
      };
    }

    // Timer fired: verify fresh DB state to check if customer purchased in the meantime
    currentStep = "CHECK_FRESH_ABANDONMENT_STATUS";
    const freshStatus = await activities.checkCheckoutStatus({
      ...actCtx,
      checkoutId,
      inactivityThresholdMinutes: 30,
    });

    if (freshStatus.isCompleted) {
      currentStep = "COMPLETED_BEFORE_ABANDONMENT";
      return {
        outcome: "COMPLETED_BEFORE_ABANDONMENT",
        stage: "WATCH_TIMER",
        checkoutId,
      };
    }

    // =========================================================================
    // PHASE 2: ABANDONMENT CONFIRMATION & CASE CREATION (s-23 §Requirements 3)
    // =========================================================================
    currentStep = "CONFIRM_ABANDONMENT_AND_CREATE_CASE";
    const confirmResult = await activities.confirmAbandonmentAndCreateCase({
      ...actCtx,
      checkoutId,
      inactivityThresholdMinutes: 30,
      proposedIncentiveDiscountMinor: input.metadata?.proposedIncentiveDiscountMinor as number | undefined,
      reminderChannel: input.metadata?.reminderChannel as "WHATSAPP" | "EMAIL" | undefined,
    });

    if (confirmResult.isCompleted) {
      currentStep = "COMPLETED_BEFORE_ABANDONMENT";
      return {
        outcome: "COMPLETED_BEFORE_ABANDONMENT",
        stage: "CONFIRM_ABANDONMENT",
        checkoutId,
      };
    }

    effectiveCaseId = confirmResult.caseId;
    actCtx.caseId = effectiveCaseId;
    const customerId = confirmResult.customerId;

    // Checkpoint: Check if signal or stop was received during qualification
    if (checkoutCompleted) {
      currentStep = "PURCHASE_RECOVERED";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor: confirmResult.cartValueMinor,
        currency: confirmResult.currency,
        checkoutId,
        recoverySource: "WORKFLOW_LINKED",
      });
      return { outcome: "RECOVERED", stage: "QUALIFICATION", caseId: effectiveCaseId };
    }

    if (isStopped) {
      currentStep = "STOPPED_QUALIFICATION";
      await activities.stopCaseWithReason({
        ...actCtx,
        stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
      });
      return { outcome: "STOPPED", stopReason, caseId: effectiveCaseId };
    }

    // =========================================================================
    // PHASE 3: TOUCH 1 — REMINDER (FIRST CONTACT DISCIPLINE: ZERO DISCOUNT)
    // =========================================================================
    currentStep = "TOUCH_1_RACE_GUARD";

    // Transactional completion race guard before send (s-23 §Requirements 7)
    const raceGuard1 = await activities.checkoutRaceGuard({
      ...actCtx,
      checkoutId,
      step: "1",
    });

    if (!raceGuard1.safeToSend || raceGuard1.isCompleted) {
      currentStep = "TOUCH_1_RACE_ABORTED";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor: confirmResult.cartValueMinor,
        currency: confirmResult.currency,
        checkoutId,
        recoverySource: "WORKFLOW_LINKED",
      });
      return {
        outcome: "RECOVERED",
        stage: "RACE_ABORTED_BEFORE_REMINDER",
        caseId: effectiveCaseId,
      };
    }

    // Send Touch 1 reminder (No discount!)
    currentStep = "TOUCH_1_SEND_REMINDER";
    await activities.sendTemplateMessage({
      ...actCtx,
      customerId,
      channel: confirmResult.reminderChannel,
      templateName: confirmResult.reminderTemplate,
      templateVariables: confirmResult.reminderVariables,
      stepKey: "1",
    });

    await activities.markCaseWaiting({
      ...actCtx,
      reason: "Touch 1 reminder sent; awaiting purchase during 4h window",
    });

    // =========================================================================
    // PHASE 4: WAIT DELAY (4h default) & TOUCH 1 PURCHASE CHECK
    // =========================================================================
    currentStep = "TOUCH_1_WAIT_DELAY";
    const reminderWaitDelay = (input.metadata?.reminderWaitDelay as string) ?? "4h";

    await condition(
      () => checkoutCompleted || isStopped,
      reminderWaitDelay,
    );

    if (checkoutCompleted) {
      currentStep = "PURCHASE_RECOVERED_AFTER_REMINDER";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor:
          completionPayload?.amount?.toString() ?? confirmResult.cartValueMinor,
        currency: completionPayload?.currency ?? confirmResult.currency,
        checkoutId,
        paymentId: completionPayload?.paymentId,
        recoverySource: "WORKFLOW_LINKED",
      });
      await activities.emitMetric({
        ...actCtx,
        metricName: "workflow_outcome_total",
        labels: { type: "CheckoutAbandonmentWorkflow", result: "RECOVERED" },
      });
      return { outcome: "RECOVERED", stage: "AFTER_REMINDER", caseId: effectiveCaseId };
    }

    if (isStopped) {
      currentStep = "TOUCH_1_STOPPED";
      await activities.stopCaseWithReason({
        ...actCtx,
        stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
      });
      return { outcome: "STOPPED", stopReason, caseId: effectiveCaseId };
    }

    // Check DB status after wait
    const checkAfterReminder = await activities.checkCheckoutStatus({
      ...actCtx,
      checkoutId,
    });

    if (checkAfterReminder.isCompleted) {
      currentStep = "PURCHASE_RECOVERED_AFTER_REMINDER";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor: confirmResult.cartValueMinor,
        currency: confirmResult.currency,
        checkoutId,
        recoverySource: "WORKFLOW_LINKED",
      });
      return { outcome: "RECOVERED", stage: "AFTER_REMINDER", caseId: effectiveCaseId };
    }

    // =========================================================================
    // PHASE 5: TOUCH 2 — OPTIONAL POLICY-APPROVED INCENTIVE (s-23 §4 & §5)
    // =========================================================================
    if (!confirmResult.incentiveApproved) {
      // Incentive was rejected by policy during initial evaluation (e.g. amount > cap)
      // Spec 23: incentive rejected by policy -> second touch skipped -> STOPPED(NO_ACTION_ALLOWED)
      currentStep = "TOUCH_2_SKIPPED_POLICY_REJECTED";
      await activities.stopCaseWithReason({
        ...actCtx,
        stopReason: "NO_ACTION_ALLOWED",
        notes: "Incentive rejected by policy (amount > cap); second touch skipped",
      });
      await activities.emitMetric({
        ...actCtx,
        metricName: "workflow_outcome_total",
        labels: { type: "CheckoutAbandonmentWorkflow", result: "STOPPED" },
      });
      return {
        outcome: "STOPPED",
        stopReason: "NO_ACTION_ALLOWED",
        caseId: effectiveCaseId,
      };
    }

    // Incentive was approved by policy -> Proceed with Touch 2
    currentStep = "TOUCH_2_POLICY_CHECK";
    const policyCheck = await activities.checkPolicyAgain({
      ...actCtx,
      actionType: "OFFER_INCENTIVE",
      actionParams: { discount_minor: confirmResult.incentiveDiscountMinor },
      amountMinor: confirmResult.cartValueMinor,
      currency: confirmResult.currency,
      customerId,
    });

    if (policyCheck.requiresApproval) {
      currentStep = "TOUCH_2_HUMAN_APPROVAL";
      const createdTask = await activities.createHumanTask({
        ...actCtx,
        taskType: "APPROVAL",
        title: "Approve checkout recovery incentive offer",
        description: "Policy requires operator approval before incentive dispatch",
        priority: "HIGH",
      });

      const approval = await awaitHumanApproval(
        actCtx,
        createdTask.taskId,
        activities,
        () => lastHumanDecision,
      );

      if (!approval.approved) {
        await activities.stopCaseWithReason({
          ...actCtx,
          stopReason: "HUMAN_REJECTED",
          notes: approval.notes,
        });
        return { outcome: "STOPPED", stopReason: "HUMAN_REJECTED", caseId: effectiveCaseId };
      }
    } else if (!policyCheck.allowed) {
      currentStep = "TOUCH_2_POLICY_REJECTED";
      const rejectionReason = policyCheck.rejectionReason ?? "POLICY_REJECTED";
      await activities.stopCaseWithReason({
        ...actCtx,
        stopReason: rejectionReason,
      });
      return { outcome: "STOPPED", stopReason: rejectionReason, caseId: effectiveCaseId };
    }

    // Completion race guard before sending incentive
    currentStep = "TOUCH_2_RACE_GUARD";
    const raceGuard2 = await activities.checkoutRaceGuard({
      ...actCtx,
      checkoutId,
      step: "2",
    });

    if (!raceGuard2.safeToSend || raceGuard2.isCompleted) {
      currentStep = "TOUCH_2_RACE_ABORTED";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor: confirmResult.cartValueMinor,
        currency: confirmResult.currency,
        checkoutId,
        recoverySource: "WORKFLOW_LINKED",
      });
      return {
        outcome: "RECOVERED",
        stage: "RACE_ABORTED_BEFORE_INCENTIVE",
        caseId: effectiveCaseId,
      };
    }

    // Send Touch 2 incentive message
    currentStep = "TOUCH_2_SEND_INCENTIVE";
    await activities.sendTemplateMessage({
      ...actCtx,
      customerId,
      channel: confirmResult.incentiveChannel ?? confirmResult.reminderChannel,
      templateName: confirmResult.incentiveTemplate ?? "checkout_incentive_reminder",
      templateVariables: confirmResult.incentiveVariables ?? {},
      stepKey: "2",
    });

    await activities.markCaseWaiting({
      ...actCtx,
      reason: "Touch 2 incentive sent; awaiting purchase during 24h window",
    });

    // Wait 24h for purchase after incentive
    currentStep = "TOUCH_2_WAIT_DELAY";
    const incentiveWaitDelay = (input.metadata?.incentiveWaitDelay as string) ?? "24h";

    await condition(
      () => checkoutCompleted || isStopped,
      incentiveWaitDelay,
    );

    if (checkoutCompleted) {
      currentStep = "PURCHASE_RECOVERED_AFTER_INCENTIVE";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor:
          completionPayload?.amount?.toString() ?? confirmResult.cartValueMinor,
        currency: completionPayload?.currency ?? confirmResult.currency,
        checkoutId,
        paymentId: completionPayload?.paymentId,
        recoverySource: "WORKFLOW_LINKED",
      });
      await activities.emitMetric({
        ...actCtx,
        metricName: "workflow_outcome_total",
        labels: { type: "CheckoutAbandonmentWorkflow", result: "RECOVERED" },
      });
      return { outcome: "RECOVERED", stage: "AFTER_INCENTIVE", caseId: effectiveCaseId };
    }

    if (isStopped) {
      currentStep = "TOUCH_2_STOPPED";
      await activities.stopCaseWithReason({
        ...actCtx,
        stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
      });
      return { outcome: "STOPPED", stopReason, caseId: effectiveCaseId };
    }

    // Final purchase check in DB
    const finalCheck = await activities.checkCheckoutStatus({
      ...actCtx,
      checkoutId,
    });

    if (finalCheck.isCompleted) {
      currentStep = "PURCHASE_RECOVERED_AFTER_INCENTIVE";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor: confirmResult.cartValueMinor,
        currency: confirmResult.currency,
        checkoutId,
        recoverySource: "WORKFLOW_LINKED",
      });
      return { outcome: "RECOVERED", stage: "AFTER_INCENTIVE", caseId: effectiveCaseId };
    }

    // Recovery window expired without purchase
    currentStep = "STOPPED_WINDOW_EXPIRED";
    await activities.stopCaseWithReason({
      ...actCtx,
      stopReason: "WINDOW_EXPIRED",
      notes: "Recovery window expired after 2 touches without completed purchase",
    });

    await activities.emitMetric({
      ...actCtx,
      metricName: "workflow_outcome_total",
      labels: { type: "CheckoutAbandonmentWorkflow", result: "STOPPED" },
    });

    return { outcome: "STOPPED", stopReason: "WINDOW_EXPIRED", caseId: effectiveCaseId };
  } catch (error: unknown) {
    currentStep = "ESCALATED_FAILURE";
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

// Workflow aliases
export const CheckoutAbandonmentWorkflow = checkoutAbandonmentWorkflow;
export const CheckoutRecoveryWorkflow = checkoutAbandonmentWorkflow;
export const checkoutRecoveryWorkflow = checkoutAbandonmentWorkflow;
