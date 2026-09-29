import {
  proxyActivities,
  setHandler,
  condition,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
import type { RecoveryActivities } from "../activities";
import { STANDARD_RETRY_POLICY } from "../framework/retry-policies";
import {
  type RecoveryWorkflowInput,
  type WorkflowState,
  type HumanDecisionSignalPayload,
  type ExternalPaymentSucceededPayload,
  pauseSignal,
  resumeSignal,
  stopSignal,
  humanDecisionSignal,
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
 * Workflow A: Failed Payment Recovery Workflow (Spec 01 §13/§15, Spec 02 §10, Spec 22).
 * Durable sequence: message → wait → retry → status check → replan/escalate/stop.
 * Consumes approved actions from s-17, executes through payment/messaging adapters,
 * records outcomes via s-26 primitives, and handles external payment success reactively.
 */
export async function failedPaymentRecoveryWorkflow(
  input: RecoveryWorkflowInput,
): Promise<{
  outcome: string;
  stopReason?: string;
  attemptNumber?: number;
  reason?: string;
}> {
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
  let externalPaymentSucceeded = false;
  let externalPaymentPayload: ExternalPaymentSucceededPayload | undefined;
  let lastHumanDecision: HumanDecisionSignalPayload | undefined;
  const humanDecisionResolvers = new Map<
    string,
    (val: HumanDecisionSignalPayload) => void
  >();
  let currentStep = "INITIALIZING";
  let currentRetryCount = 0;

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

  setHandler(externalPaymentSucceededSignal, (payload) => {
    externalPaymentSucceeded = true;
    externalPaymentPayload = payload;
  });

  // 3. Setup Query Handler
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
    retryCount: currentRetryCount,
  }));

  try {
    // 4. Emit Started Metric & Load Initial Snapshot
    currentStep = "LOAD_INITIAL_SNAPSHOT";
    await activities.emitMetric({
      ...actCtx,
      metricName: "workflow_started_total",
      labels: { type: "FailedPaymentRecoveryWorkflow" },
    });

    let snapshot = await activities.loadCaseSnapshot(actCtx);

    // If case is already terminal, exit cleanly without redundant processing
    if (
      snapshot.case.status === "RECOVERED" ||
      snapshot.case.status === "STOPPED" ||
      snapshot.case.status === "FAILED"
    ) {
      return { outcome: snapshot.case.status, stopReason: snapshot.case.statusReason ?? undefined };
    }

    const MAX_ROUNDS = 3;
    let lastDeclineCode: string | undefined;
    let lastDeclineMessage: string | undefined;

    // 5. Execution Rounds Loop (Max 3 retries bounded by policy)
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      currentStep = `ROUND_${round}_START`;

      // Checkpoint: External payment success signal received
      if (externalPaymentSucceeded) {
        currentStep = "EXTERNAL_PAYMENT_RECOVERED";
        const paymentId =
          externalPaymentPayload?.paymentId ??
          snapshot.case.sourceEntityId ??
          input.paymentId;
        await activities.recordOutcome({
          ...actCtx,
          outcome: "RECOVERED",
          recoveredAmountMinor:
            externalPaymentPayload?.amount?.toString() ??
            input.amountMinor ??
            snapshot.case.amountAtRisk.toString(),
          currency: input.currency ?? snapshot.case.currency,
          paymentId,
          recoverySource: "EXTERNAL_PAYMENT_SIGNAL",
        });
        await activities.emitMetric({
          ...actCtx,
          metricName: "workflow_outcome_total",
          labels: { type: "FailedPaymentRecoveryWorkflow", result: "RECOVERED" },
        });
        return { outcome: "RECOVERED" };
      }

      // Checkpoint: Stop signal received
      if (isStopped) {
        currentStep = `ROUND_${round}_STOPPED`;
        await activities.stopCaseWithReason({
          ...actCtx,
          stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
        });
        await activities.emitMetric({
          ...actCtx,
          metricName: "workflow_outcome_total",
          labels: { type: "FailedPaymentRecoveryWorkflow", result: "STOPPED" },
        });
        return { outcome: "STOPPED", stopReason };
      }

      // Checkpoint: Pause handling
      if (isPaused) {
        currentStep = `ROUND_${round}_PAUSED`;
        await activities.markCaseWaiting({
          ...actCtx,
          reason: "Workflow paused by operator signal",
        });
        await condition(() => !isPaused || isStopped || externalPaymentSucceeded);

        if (externalPaymentSucceeded) {
          const paymentId =
            externalPaymentPayload?.paymentId ??
            snapshot.case.sourceEntityId ??
            input.paymentId;
          await activities.recordOutcome({
            ...actCtx,
            outcome: "RECOVERED",
            recoveredAmountMinor:
              externalPaymentPayload?.amount?.toString() ??
              input.amountMinor ??
              snapshot.case.amountAtRisk.toString(),
            currency: input.currency ?? snapshot.case.currency,
            paymentId,
            recoverySource: "EXTERNAL_PAYMENT_SIGNAL",
          });
          return { outcome: "RECOVERED" };
        }

        if (isStopped) {
          await activities.stopCaseWithReason({
            ...actCtx,
            stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
          });
          return { outcome: "STOPPED", stopReason };
        }

        await activities.markCaseInProgress({
          ...actCtx,
          reason: "Workflow resumed",
        });
      }

      // Reload snapshot to detect fresh state
      snapshot = await activities.loadCaseSnapshot(actCtx);

      // Check stop conditions: Opted Out
      if (snapshot.customer?.optedOut) {
        currentStep = "STOPPED_OPT_OUT";
        await activities.stopCaseWithReason({
          ...actCtx,
          stopReason: "CUSTOMER_OPTED_OUT",
        });
        await activities.emitMetric({
          ...actCtx,
          metricName: "workflow_outcome_total",
          labels: { type: "FailedPaymentRecoveryWorkflow", result: "STOPPED" },
        });
        return { outcome: "STOPPED", stopReason: "CUSTOMER_OPTED_OUT" };
      }

      // Check stop conditions: Dispute
      if (
        snapshot.case.statusReason === "DISPUTED" ||
        snapshot.case.stopConditions?.includes("DISPUTED")
      ) {
        currentStep = "STOPPED_DISPUTED";
        await activities.stopCaseWithReason({
          ...actCtx,
          stopReason: "DISPUTED",
        });
        return { outcome: "STOPPED", stopReason: "DISPUTED" };
      }

      // 5a. Pending Communication Action (if planned)
      const pendingMsgAction = snapshot.actions.find(
        (a) =>
          (a.type === "SEND_WHATSAPP" || a.type === "SEND_EMAIL") &&
          (a.status === "PROPOSED" ||
            a.status === "EXECUTING" ||
            (a.status as string) === "APPROVED"),
      );

      if (pendingMsgAction && snapshot.customer) {
        currentStep = `ROUND_${round}_SEND_MESSAGE`;
        const channel =
          pendingMsgAction.type === "SEND_WHATSAPP" ? "WHATSAPP" : "EMAIL";
        const templateName =
          (pendingMsgAction.parameters as Record<string, unknown>)?.template as string ??
          "payment_retry_notice";
        const templateVariables =
          (pendingMsgAction.parameters as Record<string, unknown>)?.variables as Record<string, string> ?? {};

        // Policy re-check before sending message
        const msgPolicy = await activities.checkPolicyAgain({
          ...actCtx,
          actionType: pendingMsgAction.type,
          actionParams: pendingMsgAction.parameters as Record<string, unknown>,
          customerId: snapshot.customer.id,
        });

        if (msgPolicy.allowed) {
          await activities.sendTemplateMessage({
            ...actCtx,
            customerId: snapshot.customer.id,
            channel,
            templateName,
            templateVariables,
            stepKey: `round_${round}`,
            actionId: pendingMsgAction.id,
          });
        }
      }

      // 5b. Wait delay before payment retry (skippable in tests / instant wake on external payment or stop)
      currentStep = `ROUND_${round}_WAIT_DELAY`;
      const waitDelay = (input.metadata?.retryDelay as string) ?? "24h";

      await condition(
        () => externalPaymentSucceeded || isStopped,
        waitDelay,
      );

      // Check if external payment succeeded during the wait
      if (externalPaymentSucceeded) {
        currentStep = "EXTERNAL_PAYMENT_RECOVERED";
        const paymentId =
          externalPaymentPayload?.paymentId ??
          snapshot.case.sourceEntityId ??
          input.paymentId;
        await activities.recordOutcome({
          ...actCtx,
          outcome: "RECOVERED",
          recoveredAmountMinor:
            externalPaymentPayload?.amount?.toString() ??
            input.amountMinor ??
            snapshot.case.amountAtRisk.toString(),
          currency: input.currency ?? snapshot.case.currency,
          paymentId,
          recoverySource: "EXTERNAL_PAYMENT_SIGNAL",
        });
        await activities.emitMetric({
          ...actCtx,
          metricName: "workflow_outcome_total",
          labels: { type: "FailedPaymentRecoveryWorkflow", result: "RECOVERED" },
        });
        return { outcome: "RECOVERED" };
      }

      if (isStopped) {
        currentStep = `ROUND_${round}_STOPPED`;
        await activities.stopCaseWithReason({
          ...actCtx,
          stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
        });
        return { outcome: "STOPPED", stopReason };
      }

      // 5c. Policy re-check for RETRY_PAYMENT
      // s-22/s-24 audit: thread the per-round retry count explicitly so
      // POL-MAXRETRY can fire per-round (retry_count = completed retries
      // before this round). checkPolicyAgain falls back to live DB
      // COUNT(payment_attempts) when counters are absent.
      currentStep = `ROUND_${round}_POLICY_CHECK`;
      const policyCheck = await activities.checkPolicyAgain({
        ...actCtx,
        actionType: "RETRY_PAYMENT",
        actionParams: { attempt: round },
        amountMinor: snapshot.case.amountAtRisk.toString(),
        currency: snapshot.case.currency,
        customerId: snapshot.customer?.id,
        counters: { retry_count: round - 1 },
      });

      if (policyCheck.requiresApproval) {
        currentStep = `ROUND_${round}_HUMAN_APPROVAL`;
        const createdTask = await activities.createHumanTask({
          ...actCtx,
          taskType: "APPROVAL",
          title: `Approve payment retry #${round}`,
          description: "Policy requires operator authorization before retry execution",
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
          return { outcome: "STOPPED", stopReason: "HUMAN_REJECTED" };
        }
      } else if (!policyCheck.allowed) {
        currentStep = `ROUND_${round}_POLICY_REJECTED`;
        const rejectionReason = policyCheck.rejectionReason ?? "POLICY_REJECTED";
        await activities.stopCaseWithReason({
          ...actCtx,
          stopReason: rejectionReason,
        });
        return { outcome: "STOPPED", stopReason: rejectionReason };
      }

      // 5d. Pre-retry fresh-state re-check (audit s-22): reload snapshot immediately
      // before money movement to catch external success / opt-out / dispute that landed
      // during the wait without a signal (missed webhook). Provider-level status polling
      // for UNKNOWN outcomes is handled post-attempt via refreshPaymentStatus; crash-window
      // double-execution is covered by idempotency-key claim + s-31 EXECUTING sweeper
      // (reconciler backstop resolves via provider status query, never blind re-executes).
      currentStep = `ROUND_${round}_PRE_RETRY_RECHECK`;
      const preRetrySnapshot = await activities.loadCaseSnapshot(actCtx);
      snapshot = preRetrySnapshot;
      if (
        snapshot.case.status === "RECOVERED" ||
        snapshot.case.status === "STOPPED" ||
        snapshot.case.status === "FAILED"
      ) {
        return { outcome: snapshot.case.status, stopReason: snapshot.case.statusReason ?? undefined };
      }
      if (externalPaymentSucceeded) {
        currentStep = "EXTERNAL_PAYMENT_RECOVERED";
        const extPaymentId =
          externalPaymentPayload?.paymentId ??
          snapshot.case.sourceEntityId ??
          input.paymentId;
        await activities.recordOutcome({
          ...actCtx,
          outcome: "RECOVERED",
          recoveredAmountMinor:
            externalPaymentPayload?.amount?.toString() ??
            input.amountMinor ??
            snapshot.case.amountAtRisk.toString(),
          currency: input.currency ?? snapshot.case.currency,
          paymentId: extPaymentId,
          recoverySource: "EXTERNAL_PAYMENT_SIGNAL",
        });
        return { outcome: "RECOVERED" };
      }
      if (isStopped || snapshot.customer?.optedOut) {
        const reason = stopReason ?? (snapshot.customer?.optedOut ? "CUSTOMER_OPTED_OUT" : "STOP_SIGNAL_RECEIVED");
        await activities.stopCaseWithReason({ ...actCtx, stopReason: reason });
        return { outcome: "STOPPED", stopReason: reason };
      }
      if (
        snapshot.case.statusReason === "DISPUTED" ||
        snapshot.case.stopConditions?.includes("DISPUTED")
      ) {
        await activities.stopCaseWithReason({ ...actCtx, stopReason: "DISPUTED" });
        return { outcome: "STOPPED", stopReason: "DISPUTED" };
      }

      // 5e. Execute Payment Retry
      currentStep = `ROUND_${round}_EXECUTE_RETRY`;
      currentRetryCount = round;
      const paymentId = (snapshot.case.sourceEntityId ?? input.paymentId)!;

      const retryResult = await activities.executeRetryPayment({
        ...actCtx,
        paymentId,
        attemptNumber: round,
        amountMinor: snapshot.case.amountAtRisk.toString(),
        currency: snapshot.case.currency,
        customerId: snapshot.customer?.id,
        customerEmail: snapshot.customer?.email ?? undefined,
      });

      if (retryResult.status === "SUCCEEDED") {
        currentStep = "RECORD_OUTCOME_SUCCEEDED";
        await activities.recordOutcome({
          ...actCtx,
          outcome: "RECOVERED",
          recoveredAmountMinor: snapshot.case.amountAtRisk.toString(),
          currency: snapshot.case.currency,
          paymentId,
          recoverySource: "WORKFLOW_LINKED",
        });
        await activities.emitMetric({
          ...actCtx,
          metricName: "workflow_outcome_total",
          labels: { type: "FailedPaymentRecoveryWorkflow", result: "RECOVERED" },
        });
        return { outcome: "RECOVERED", attemptNumber: round };
      }

      if (
        retryResult.status === "UNKNOWN" ||
        retryResult.status === "ACCEPTED_ASYNC"
      ) {
        // Status refresh polling loop
        currentStep = `ROUND_${round}_POLL_STATUS`;
        let pollSucceeded = false;
        for (let poll = 1; poll <= 3; poll++) {
          await sleep("5s");
          const statusCheck = await activities.refreshPaymentStatus({
            ...actCtx,
            paymentId,
          });
          if (statusCheck.status === "SUCCEEDED") {
            pollSucceeded = true;
            break;
          }
          if (statusCheck.status === "FAILED") {
            break;
          }
        }

        if (pollSucceeded) {
          currentStep = "RECORD_OUTCOME_SUCCEEDED";
          await activities.recordOutcome({
            ...actCtx,
            outcome: "RECOVERED",
            recoveredAmountMinor: snapshot.case.amountAtRisk.toString(),
            currency: snapshot.case.currency,
            paymentId,
            recoverySource: "WORKFLOW_LINKED",
          });
          await activities.emitMetric({
            ...actCtx,
            metricName: "workflow_outcome_total",
            labels: { type: "FailedPaymentRecoveryWorkflow", result: "RECOVERED" },
          });
          return { outcome: "RECOVERED", attemptNumber: round };
        }
      }

      lastDeclineCode = retryResult.declineCode;
      lastDeclineMessage = retryResult.declineMessage ?? undefined;
    }

    // 6. REPLAN PATH (After max 3 retries exhausted: exactly one replan)
    currentStep = "REPLAN_STAGE";
    const replan = await activities.requestReplanDecision({
      ...actCtx,
      attemptsCount: currentRetryCount,
      lastDeclineCode,
      lastDeclineMessage,
      proposedOverride: input.metadata?.replanOverride as
        | {
            actionType?: string;
            stopReason?: string;
            requiresApproval?: boolean;
            discountMinor?: number;
          }
        | undefined,
    });

    if (replan.requiresApproval) {
      currentStep = "REPLAN_HUMAN_APPROVAL";
      const createdTask = await activities.createHumanTask({
        ...actCtx,
        taskType: "APPROVAL",
        title: "Approve replanned recovery action",
        description: "Replan proposed recovery action requiring operator approval",
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
        return { outcome: "STOPPED", stopReason: "HUMAN_REJECTED" };
      }
    }

    if (replan.replanAction === "CREATE_HUMAN_TASK") {
      currentStep = "ESCALATED_HUMAN_TASK";
      await activities.createHumanTask({
        ...actCtx,
        taskType: "GENERAL",
        title: "Manual recovery review after exhausted payment retries",
        description: "Payment retries exhausted without recovery; human follow-up requested",
        priority: "HIGH",
      });
      return { outcome: "ESCALATED", reason: "MAX_RETRIES_ESCALATED" };
    }

    if (
      replan.replanAction === "SEND_MESSAGE" &&
      replan.actions.length > 0 &&
      snapshot.customer
    ) {
      const act = replan.actions[0];
      const channel = act.type === "SEND_WHATSAPP" ? "WHATSAPP" : "EMAIL";
      const actParams = act.parameters as Record<string, unknown> | undefined;
      await activities.sendTemplateMessage({
        ...actCtx,
        customerId: snapshot.customer.id,
        channel,
        templateName: (actParams?.template as string) ?? "payment_final_notice",
        templateVariables: (actParams?.variables as Record<string, string>) ?? {},
        stepKey: "replan_notice",
      });
    }

    // Default replan outcome: STOP_CASE with MAX_RETRIES (or replan.stopReason)
    currentStep = "STOPPED_MAX_RETRIES";
    const finalStopReason = replan.stopReason ?? "MAX_RETRIES";
    await activities.stopCaseWithReason({
      ...actCtx,
      stopReason: finalStopReason,
      notes: `Max retries (${currentRetryCount}) exhausted; replan resolved to stop`,
    });

    await activities.emitMetric({
      ...actCtx,
      metricName: "workflow_outcome_total",
      labels: { type: "FailedPaymentRecoveryWorkflow", result: "STOPPED" },
    });

    return { outcome: "STOPPED", stopReason: finalStopReason };
  } catch (error: unknown) {
    // 7. Unhandled execution errors: escalate to emergency human review
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

// Workflow alias: the backend dispatches the PascalCase contract name
// (pipeline.service.ts, @repo/orchestration types) and the Temporal SDK
// registers types by bundle export name, so this alias must exist here
// alongside the camelCase function — same convention as the other workflow
// files (checkout-abandonment, invoice-overdue, promise-to-pay).
export const FailedPaymentRecoveryWorkflow = failedPaymentRecoveryWorkflow;
