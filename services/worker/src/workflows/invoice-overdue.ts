import {
  proxyActivities,
  setHandler,
  condition,
  startChild,
  workflowInfo,
  type ChildWorkflowHandle,
} from "@temporalio/workflow";
import type { RecoveryActivities } from "../activities";
import { STANDARD_RETRY_POLICY } from "../framework/retry-policies";
import {
  type RecoveryWorkflowInput,
  type WorkflowState,
  type HumanDecisionSignalPayload,
  type ExternalPaymentSucceededPayload,
  type InvoicePaidSignalPayload,
  type CustomerRepliedSignalPayload,
  type DisputeOpenedSignalPayload,
  pauseSignal,
  resumeSignal,
  stopSignal,
  humanDecisionSignal,
  externalPaymentSucceededSignal,
  invoicePaidSignal,
  customerRepliedSignal,
  disputeOpenedSignal,
  workflowStateQuery,
  awaitHumanApproval,
} from "./shared";
import {
  promiseToPayWorkflow,
  type PromiseToPayWorkflowOutput,
} from "./promise-to-pay";

// Proxy typed activities with standard retry options
const activities = proxyActivities<RecoveryActivities>({
  startToCloseTimeout: "30s",
  retry: STANDARD_RETRY_POLICY,
});

export interface InvoiceOverdueWorkflowOutput {
  outcome: "RECOVERED" | "STOPPED" | "ESCALATED" | "FAILED";
  stopReason?: string;
  stage?: string;
  reason?: string;
  recoveredAmountMinor?: string;
  ptpStatus?: string;
  taskId?: string;
}

/**
 * Workflow C: Overdue Invoice & Promise-to-Pay Workflow (Spec 00 Surface 3, Spec 01 §15, Spec 02 §12, Step 24).
 *
 * Durable Multi-Week Progression:
 * 1. Ladder Step 1 (Day 0): Polite reminder (EMAIL).
 * 2. Ladder Step 2 (+3d): Follow-up reminder (EMAIL or WHATSAPP).
 * 3. Ladder Step 3 (+7d): Final notice with dynamic payment link (Subject to POL-HIGHVALUE approval if amount > ₹100,000).
 * 4. Response Branches:
 *    - Payment Received -> RECOVERED (WORKFLOW_LINKED).
 *    - Dispute Arrived -> Hard stop automation immediately (STOPPED / DISPUTED) + create DISPUTE_REVIEW human task.
 *    - Promise to Pay -> Awaits child PromiseToPayWorkflow (Composition).
 *        ├─ Honored -> RECOVERED.
 *        ├─ Broken -> 1 follow-up message -> Escalate if silent.
 *        └─ Expired -> Escalate once.
 *    - Opt-Out -> STOPPED (CUSTOMER_OPTED_OUT).
 * 5. Replan / Escalation -> Escalation package drafting for finance team review (≤500 chars).
 */
export async function invoiceOverdueWorkflow(
  input: RecoveryWorkflowInput,
): Promise<InvoiceOverdueWorkflowOutput> {
  const info = workflowInfo();
  const invoiceId = input.invoiceId ?? input.caseId;
  const effectiveCaseId = input.caseId;

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
  let invoicePaid = false;
  let paymentId: string | undefined;
  let paidAmount: string | number | undefined;
  let paidCurrency: string | undefined;
  let isDisputed = false;
  let disputeReason: string | undefined;
  let customerReplied = false;
  let replyPayload: CustomerRepliedSignalPayload | undefined;
  let lastHumanDecision: HumanDecisionSignalPayload | undefined;
  let activeChildPtpHandle: ChildWorkflowHandle<typeof promiseToPayWorkflow> | undefined;
  const humanDecisionResolvers = new Map<
    string,
    (val: HumanDecisionSignalPayload) => void
  >();
  let currentStep = "INITIALIZING";

  let emailCount = 0;
  let whatsappCount = 0;
  let escalationCreated = false;

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
    if (payload?.reason === "DISPUTED") {
      isDisputed = true;
    }
  });

  setHandler(humanDecisionSignal, (payload) => {
    lastHumanDecision = payload;
    const resolver = humanDecisionResolvers.get(payload.taskId);
    if (resolver) {
      resolver(payload);
      humanDecisionResolvers.delete(payload.taskId);
    }
  });

  setHandler(invoicePaidSignal, async (payload: InvoicePaidSignalPayload) => {
    invoicePaid = true;
    paymentId = payload.paymentId;
    paidAmount = payload.amount;
    paidCurrency = payload.currency;
    if (activeChildPtpHandle) {
      try {
        await activeChildPtpHandle.signal(invoicePaidSignal, payload);
      } catch {
        // Child workflow might have already completed
      }
    }
  });

  setHandler(
    externalPaymentSucceededSignal,
    async (payload: ExternalPaymentSucceededPayload) => {
      invoicePaid = true;
      paymentId = payload.paymentId;
      paidAmount = payload.amount;
      paidCurrency = payload.currency;
      if (activeChildPtpHandle) {
        try {
          await activeChildPtpHandle.signal(externalPaymentSucceededSignal, payload);
        } catch {
          // Child workflow might have already completed
        }
      }
    },
  );

  setHandler(customerRepliedSignal, (payload: CustomerRepliedSignalPayload) => {
    customerReplied = true;
    replyPayload = payload;
    if (payload.type === "OPT_OUT") {
      isStopped = true;
      stopReason = "CUSTOMER_OPTED_OUT";
    } else if (payload.type === "COMPLAINT" || payload.type === "DISPUTE") {
      isDisputed = true;
      disputeReason = payload.text ?? "CUSTOMER_DISPUTE_SIGNAL";
    }
  });

  setHandler(disputeOpenedSignal, (payload: DisputeOpenedSignalPayload) => {
    isDisputed = true;
    disputeReason = payload.reason ?? "INVOICE_DISPUTED";
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

  // Helper: Escalate case once with deduping
  async function escalateCase(title: string, description: string): Promise<string> {
    if (escalationCreated) return "";
    escalationCreated = true;
    const task = await activities.createHumanTask({
      ...actCtx,
      taskType: "GENERAL",
      title,
      description,
      priority: "HIGH",
    });
    await activities.appendTimeline({
      ...actCtx,
      type: "CASE_ESCALATED",
      description: `Case escalated: ${title}`,
      payload: { taskId: task.taskId, title },
    });
    return task.taskId;
  }

  // Helper: Handle Dispute Stop
  async function handleDisputeStop(reason: string): Promise<InvoiceOverdueWorkflowOutput> {
    currentStep = "STOPPED_DISPUTED";
    await activities.stopCaseWithReason({
      ...actCtx,
      stopReason: "DISPUTED",
      notes: reason,
    });
    await activities.createHumanTask({
      ...actCtx,
      taskType: "DISPUTE_REVIEW",
      title: `Dispute review for invoice ${invoiceId}`,
      description: `Customer disputed invoice: ${reason}. All recovery automation halted.`,
      priority: "HIGH",
    });
    await activities.emitMetric({
      ...actCtx,
      metricName: "dispute_stop_total",
      labels: { type: "OverdueInvoiceWorkflow" },
    });
    await activities.emitMetric({
      ...actCtx,
      metricName: "workflow_outcome_total",
      labels: { type: "OverdueInvoiceWorkflow", result: "STOPPED" },
    });
    return { outcome: "STOPPED", stopReason: "DISPUTED", reason };
  }

  // Helper: Process Promise to Pay Child Workflow
  async function handlePromiseToPay(
    customerId: string,
    amountAtRisk: string,
    currency: string,
    promisedDate: string,
  ): Promise<InvoiceOverdueWorkflowOutput | null> {
    currentStep = "PTP_CHILD_WORKFLOW";
    const childWorkflowId = `ptp:${effectiveCaseId}:${info.runId}`;

    const childHandle = await startChild(promiseToPayWorkflow, {
      workflowId: childWorkflowId,
      args: [
        {
          tenantId: input.tenantId,
          caseId: effectiveCaseId,
          customerId,
          invoiceId,
          promisedAmountMinor: amountAtRisk,
          currency,
          promisedByDate: promisedDate,
          metadata: input.metadata,
        },
      ],
    });

    activeChildPtpHandle = childHandle;

    if (invoicePaid) {
      await childHandle.signal(invoicePaidSignal, {
        invoiceId,
        paymentId,
        amount: paidAmount,
        currency: paidCurrency,
      });
    }

    const ptpResult: PromiseToPayWorkflowOutput = await childHandle.result();
    activeChildPtpHandle = undefined;

    if (ptpResult.status === "HONORED") {
      currentStep = "PTP_RECOVERED";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor: amountAtRisk,
        currency,
        invoiceId,
        paymentId: ptpResult.paymentId,
        recoverySource: "WORKFLOW_LINKED",
      });
      await activities.emitMetric({
        ...actCtx,
        metricName: "workflow_outcome_total",
        labels: { type: "OverdueInvoiceWorkflow", result: "RECOVERED" },
      });
      return {
        outcome: "RECOVERED",
        ptpStatus: "HONORED",
        recoveredAmountMinor: amountAtRisk,
      };
    }

    if (ptpResult.status === "DISPUTED") {
      return await handleDisputeStop(ptpResult.reason ?? "Dispute raised during PTP wait");
    }

    if (ptpResult.status === "BROKEN") {
      currentStep = "PTP_BROKEN_FOLLOWUP";
      // Send single follow-up message
      const brokenMsgPolicy = await activities.checkPolicyAgain({
        ...actCtx,
        actionType: "SEND_EMAIL",
        customerId,
        counters: { email_count_14d: ++emailCount },
      });

      if (brokenMsgPolicy.allowed) {
        await activities.sendTemplateMessage({
          ...actCtx,
          customerId,
          channel: "EMAIL",
          templateName: "invoice_promise_broken_followup",
          templateVariables: {
            customer_name: "Customer",
            amount_due: amountAtRisk,
            currency,
          },
          stepKey: "ptp_broken_followup",
        });
      }

      // Wait 24h for payment before escalating
      const brokenWaitDelay = (input.metadata?.brokenPtpWaitDelay as string) ?? "24h";
      await condition(() => invoicePaid || isDisputed || isStopped, brokenWaitDelay);

      if (invoicePaid) {
        await activities.recordOutcome({
          ...actCtx,
          outcome: "RECOVERED",
          recoveredAmountMinor: amountAtRisk,
          currency,
          invoiceId,
          paymentId,
          recoverySource: "WORKFLOW_LINKED",
        });
        return { outcome: "RECOVERED", recoveredAmountMinor: amountAtRisk };
      }

      if (isDisputed) {
        return await handleDisputeStop(disputeReason ?? "Disputed after broken promise");
      }

      // Escalate if still silent
      currentStep = "PTP_BROKEN_ESCALATED";
      const taskId = await escalateCase(
        "Manual follow-up for broken promise to pay",
        `Customer promise to pay for invoice ${invoiceId} was broken and follow-up was unanswered.`,
      );
      await activities.emitMetric({
        ...actCtx,
        metricName: "workflow_outcome_total",
        labels: { type: "OverdueInvoiceWorkflow", result: "ESCALATED" },
      });
      return { outcome: "ESCALATED", ptpStatus: "BROKEN", taskId };
    }

    if (ptpResult.status === "EXPIRED") {
      currentStep = "PTP_EXPIRED_ESCALATED";
      const taskId = await escalateCase(
        "Manual follow-up for expired promise to pay",
        `Promise to pay for invoice ${invoiceId} reached hard expiry without payment.`,
      );
      await activities.emitMetric({
        ...actCtx,
        metricName: "workflow_outcome_total",
        labels: { type: "OverdueInvoiceWorkflow", result: "ESCALATED" },
      });
      return { outcome: "ESCALATED", ptpStatus: "EXPIRED", taskId };
    }

    return null;
  }

  try {
    currentStep = "LOAD_INITIAL_SNAPSHOT";
    await activities.emitMetric({
      ...actCtx,
      metricName: "workflow_started_total",
      labels: { type: "OverdueInvoiceWorkflow" },
    });

    const snapshot = await activities.loadCaseSnapshot(actCtx);

    // If case is already terminal, exit cleanly
    if (
      snapshot.case.status === "RECOVERED" ||
      snapshot.case.status === "STOPPED" ||
      snapshot.case.status === "FAILED"
    ) {
      return {
        outcome: snapshot.case.status as "RECOVERED" | "STOPPED" | "FAILED",
        stopReason: snapshot.case.statusReason ?? undefined,
      };
    }

    const customerId = snapshot.customer?.id ?? snapshot.case.customerId;
    const amountAtRiskMinor = snapshot.case.amountAtRisk.toString();
    const currency = snapshot.case.currency;

    // Check if invoice already paid before workflow started (paid-before-start safety check)
    const initialCheck = await activities.checkInvoiceStatus({
      ...actCtx,
      invoiceId,
    });

    if (initialCheck.isPaid) {
      currentStep = "ALREADY_PAID_EXIT";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor: amountAtRiskMinor,
        currency,
        invoiceId,
        recoverySource: "PRE_EXISTING",
      });
      return { outcome: "RECOVERED", recoveredAmountMinor: amountAtRiskMinor };
    }

    if (initialCheck.isDisputed || isDisputed) {
      return await handleDisputeStop(disputeReason ?? "Invoice marked as disputed");
    }

    // =========================================================================
    // LADDER STEP 1: DAY 0 POLITE REMINDER (EMAIL)
    // =========================================================================
    currentStep = "LADDER_STEP_1_START";

    // Policy re-check for Step 1
    const policy1 = await activities.checkPolicyAgain({
      ...actCtx,
      actionType: "SEND_EMAIL",
      customerId,
      counters: { email_count_14d: emailCount + 1 },
    });

    if (policy1.allowed) {
      emailCount++;
      await activities.sendTemplateMessage({
        ...actCtx,
        customerId,
        channel: "EMAIL",
        templateName: "invoice_overdue_polite_reminder",
        templateVariables: {
          customer_name: snapshot.customer?.name ?? "Customer",
          invoice_number: invoiceId,
          amount_due: amountAtRiskMinor,
          currency,
        },
        stepKey: "ladder_1",
      });

      await activities.emitMetric({
        ...actCtx,
        metricName: "ladder_step_reached_total",
        labels: { step: "1" },
      });
    }

    await activities.markCaseWaiting({
      ...actCtx,
      reason: "Ladder step 1 (polite reminder) sent; waiting for response or payment",
    });

    // Wait delay 1 (+3d default, skippable in tests)
    const ladder1Delay = (input.metadata?.ladder1Delay as string) ?? "3d";
    currentStep = "LADDER_STEP_1_WAIT";

    await condition(
      () => invoicePaid || isDisputed || isStopped || customerReplied,
      ladder1Delay,
    );

    // Response Branching Check after Step 1
    if (customerReplied && replyPayload?.type === "PROMISE_TO_PAY") {
      const promisedDate = replyPayload.promisedByDate ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const ptpResult = await handlePromiseToPay(
        customerId,
        amountAtRiskMinor,
        currency,
        promisedDate,
      );
      if (ptpResult) return ptpResult;
    }

    if (isDisputed) {
      return await handleDisputeStop(disputeReason ?? "Dispute raised during Ladder 1 wait");
    }

    if (invoicePaid) {
      currentStep = "RECOVERED_AFTER_LADDER_1";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor: paidAmount?.toString() ?? amountAtRiskMinor,
        currency: paidCurrency ?? currency,
        invoiceId,
        paymentId,
        recoverySource: "WORKFLOW_LINKED",
      });
      await activities.emitMetric({
        ...actCtx,
        metricName: "workflow_outcome_total",
        labels: { type: "OverdueInvoiceWorkflow", result: "RECOVERED" },
      });
      return { outcome: "RECOVERED", stage: "LADDER_1" };
    }

    if (isStopped) {
      currentStep = "STOPPED_LADDER_1";
      await activities.stopCaseWithReason({
        ...actCtx,
        stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
      });
      return { outcome: "STOPPED", stopReason };
    }

    // =========================================================================
    // LADDER STEP 2: +3d FOLLOW-UP (EMAIL or WHATSAPP)
    // =========================================================================
    currentStep = "LADDER_STEP_2_START";
    customerReplied = false; // Reset response flag for next step

    const channel2 = (input.metadata?.step2Channel as "WHATSAPP" | "EMAIL") ?? "EMAIL";
    const counters2: Record<string, number> =
      channel2 === "EMAIL"
        ? { email_count_14d: emailCount + 1 }
        : { whatsapp_count_7d: whatsappCount + 1 };

    const policy2 = await activities.checkPolicyAgain({
      ...actCtx,
      actionType: channel2 === "EMAIL" ? "SEND_EMAIL" : "SEND_WHATSAPP",
      customerId,
      counters: counters2,
    });

    if (policy2.allowed) {
      if (channel2 === "EMAIL") emailCount++;
      else whatsappCount++;

      await activities.sendTemplateMessage({
        ...actCtx,
        customerId,
        channel: channel2,
        templateName: "invoice_overdue_followup",
        templateVariables: {
          customer_name: snapshot.customer?.name ?? "Customer",
          invoice_number: invoiceId,
          amount_due: amountAtRiskMinor,
          currency,
        },
        stepKey: "ladder_2",
      });

      await activities.emitMetric({
        ...actCtx,
        metricName: "ladder_step_reached_total",
        labels: { step: "2" },
      });
    }

    await activities.markCaseWaiting({
      ...actCtx,
      reason: "Ladder step 2 (follow-up) sent; waiting for response or payment",
    });

    // Wait delay 2 (+7d default)
    const ladder2Delay = (input.metadata?.ladder2Delay as string) ?? "7d";
    currentStep = "LADDER_STEP_2_WAIT";

    await condition(
      () => invoicePaid || isDisputed || isStopped || customerReplied,
      ladder2Delay,
    );

    if (customerReplied && replyPayload?.type === "PROMISE_TO_PAY") {
      const promisedDate = replyPayload.promisedByDate ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const ptpResult = await handlePromiseToPay(
        customerId,
        amountAtRiskMinor,
        currency,
        promisedDate,
      );
      if (ptpResult) return ptpResult;
    }

    if (isDisputed) {
      return await handleDisputeStop(disputeReason ?? "Dispute raised during Ladder 2 wait");
    }

    if (invoicePaid) {
      currentStep = "RECOVERED_AFTER_LADDER_2";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor: paidAmount?.toString() ?? amountAtRiskMinor,
        currency: paidCurrency ?? currency,
        invoiceId,
        paymentId,
        recoverySource: "WORKFLOW_LINKED",
      });
      await activities.emitMetric({
        ...actCtx,
        metricName: "workflow_outcome_total",
        labels: { type: "OverdueInvoiceWorkflow", result: "RECOVERED" },
      });
      return { outcome: "RECOVERED", stage: "LADDER_2" };
    }

    if (isStopped) {
      currentStep = "STOPPED_LADDER_2";
      await activities.stopCaseWithReason({
        ...actCtx,
        stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
      });
      return { outcome: "STOPPED", stopReason };
    }

    // =========================================================================
    // LADDER STEP 3: +7d FINAL NOTICE WITH PAYMENT LINK & HIGH-VALUE GOVERNANCE
    // =========================================================================
    currentStep = "LADDER_STEP_3_START";
    customerReplied = false;

    // Check High-Value Rule / Incentive Approval (POL-HIGHVALUE: amount > ₹100,000)
    const proposedIncentiveDiscount = input.metadata?.proposedIncentiveDiscountMinor as number | undefined;
    let paymentLinkUrl = `https://pay.example.com/inv/${invoiceId}`;

    if (proposedIncentiveDiscount && proposedIncentiveDiscount > 0) {
      const highValuePolicy = await activities.checkPolicyAgain({
        ...actCtx,
        actionType: "OFFER_INCENTIVE",
        actionParams: { discount_minor: proposedIncentiveDiscount },
        amountMinor: amountAtRiskMinor,
        currency,
        customerId,
      });

      if (highValuePolicy.requiresApproval) {
        currentStep = "LADDER_STEP_3_HIGH_VALUE_APPROVAL";
        const createdTask = await activities.createHumanTask({
          ...actCtx,
          taskType: "APPROVAL",
          title: `Approve high-value invoice incentive for invoice ${invoiceId}`,
          description: `Invoice amount (₹${Number(amountAtRiskMinor) / 100}) exceeds ₹100,000 threshold; operator authorization required for incentive/discount offer.`,
          priority: "HIGH",
        });

        const approval = await awaitHumanApproval(
          actCtx,
          createdTask.taskId,
          activities,
          () => lastHumanDecision,
        );

        if (!approval.approved) {
          // If rejected by human, skip discount and proceed without discount (Scenario C parity)
          currentStep = "LADDER_STEP_3_INCENTIVE_REJECTED";
        }
      }
    }

    // Generate payment link
    const paymentLinkResult = await activities.createPaymentLinkAndStore({
      ...actCtx,
      customerId,
      amountMinor: amountAtRiskMinor,
      currency,
      expiresInMinutes: 72 * 60,
    });
    paymentLinkUrl = paymentLinkResult.url;

    // Policy check for final notice message (email contact cap enforcement: max 3 emails)
    const policy3 = await activities.checkPolicyAgain({
      ...actCtx,
      actionType: "SEND_EMAIL",
      customerId,
      counters: { email_count_14d: emailCount + 1 },
    });

    if (policy3.allowed) {
      emailCount++;
      await activities.sendTemplateMessage({
        ...actCtx,
        customerId,
        channel: "EMAIL",
        templateName: "invoice_overdue_final_notice",
        templateVariables: {
          customer_name: snapshot.customer?.name ?? "Customer",
          invoice_number: invoiceId,
          amount_due: amountAtRiskMinor,
          currency,
          payment_link: paymentLinkUrl,
        },
        stepKey: "ladder_3",
      });

      await activities.emitMetric({
        ...actCtx,
        metricName: "ladder_step_reached_total",
        labels: { step: "3" },
      });
    }

    await activities.markCaseWaiting({
      ...actCtx,
      reason: "Ladder step 3 (final notice) sent; awaiting payment before replan",
    });

    // Wait delay 3 (+3d default)
    const ladder3Delay = (input.metadata?.ladder3Delay as string) ?? "3d";
    currentStep = "LADDER_STEP_3_WAIT";

    await condition(
      () => invoicePaid || isDisputed || isStopped || customerReplied,
      ladder3Delay,
    );

    if (customerReplied && replyPayload?.type === "PROMISE_TO_PAY") {
      const promisedDate = replyPayload.promisedByDate ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const ptpResult = await handlePromiseToPay(
        customerId,
        amountAtRiskMinor,
        currency,
        promisedDate,
      );
      if (ptpResult) return ptpResult;
    }

    if (isDisputed) {
      return await handleDisputeStop(disputeReason ?? "Dispute raised during Ladder 3 wait");
    }

    if (invoicePaid) {
      currentStep = "RECOVERED_AFTER_LADDER_3";
      await activities.recordOutcome({
        ...actCtx,
        outcome: "RECOVERED",
        recoveredAmountMinor: paidAmount?.toString() ?? amountAtRiskMinor,
        currency: paidCurrency ?? currency,
        invoiceId,
        paymentId,
        recoverySource: "WORKFLOW_LINKED",
      });
      await activities.emitMetric({
        ...actCtx,
        metricName: "workflow_outcome_total",
        labels: { type: "OverdueInvoiceWorkflow", result: "RECOVERED" },
      });
      return { outcome: "RECOVERED", stage: "LADDER_3" };
    }

    if (isStopped) {
      currentStep = "STOPPED_LADDER_3";
      await activities.stopCaseWithReason({
        ...actCtx,
        stopReason: stopReason ?? "STOP_SIGNAL_RECEIVED",
      });
      return { outcome: "STOPPED", stopReason };
    }

    // =========================================================================
    // REPLAN & ESCALATION PATH (Repeated silence after final notice)
    // =========================================================================
    currentStep = "REPLAN_AND_ESCALATE";

    const replan = await activities.requestReplanDecision({
      ...actCtx,
      attemptsCount: 3,
      proposedOverride: {
        actionType: "CREATE_HUMAN_TASK",
        requiresApproval: false,
      },
    });

    const escalationSummary = `Invoice ${invoiceId} remains unpaid after 3 reminder ladder touches. Customer silent. Amount: ₹${Number(amountAtRiskMinor) / 100} ${currency}. Escalate to finance.`;

    const taskId = await escalateCase(
      `Finance escalation for overdue invoice ${invoiceId}`,
      escalationSummary.slice(0, 500),
    );

    await activities.emitMetric({
      ...actCtx,
      metricName: "workflow_outcome_total",
      labels: { type: "OverdueInvoiceWorkflow", result: "ESCALATED" },
    });

    return {
      outcome: "ESCALATED",
      stage: "FINAL_NOTICE_EXHAUSTED",
      reason: replan.replanAction ?? "LADDER_EXHAUSTED",
      taskId,
    };
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

// Workflow Aliases
export const OverdueInvoiceWorkflow = invoiceOverdueWorkflow;
export const InvoiceRecoveryWorkflow = invoiceOverdueWorkflow;
