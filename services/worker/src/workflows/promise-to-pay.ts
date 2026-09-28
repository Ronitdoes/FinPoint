import {
  proxyActivities,
  setHandler,
  condition,
  workflowInfo,
} from "@temporalio/workflow";
import type { RecoveryActivities } from "../activities";
import { STANDARD_RETRY_POLICY } from "../framework/retry-policies";
import {
  type InvoicePaidSignalPayload,
  invoicePaidSignal,
  externalPaymentSucceededSignal,
  disputeOpenedSignal,
  stopSignal,
} from "./shared";

// Proxy typed activities with standard retry options
const activities = proxyActivities<RecoveryActivities>({
  startToCloseTimeout: "30s",
  retry: STANDARD_RETRY_POLICY,
});

export interface PromiseToPayWorkflowInput {
  tenantId: string;
  caseId: string;
  customerId: string;
  invoiceId?: string;
  promisedAmountMinor: string;
  currency: string;
  // Optional: when omitted, createPromiseToPay activity defaults to +7d (activity
  // time) and returns the resolved date + computed wait. Workflows must NOT call
  // Date.now() to synthesize a default (Temporal determinism, audit s-24).
  promisedByDate?: string; // YYYY-MM-DD
  gracePeriodHours?: number; // default 24h
  traceparent?: string;
  metadata?: Record<string, unknown>;
}

export interface PromiseToPayWorkflowOutput {
  status: "HONORED" | "BROKEN" | "EXPIRED" | "DISPUTED" | "STOPPED";
  promiseId?: string;
  paymentId?: string;
  resolvedAt?: string;
  reason?: string;
}

/**
 * Child Workflow: Promise to Pay Sub-Workflow (Spec 01 §15 Workflow C, Spec 02 §12, Step 24).
 * Manages the PTP lifecycle: creates PTP record (MADE), awaits payment signal or due date + 24h grace,
 * transitions to HONORED, BROKEN, or EXPIRED with guarded updates, and exports completion metrics.
 *
 * Child-workflow composition keeps the parent OverdueInvoiceWorkflow timeline concise and clean.
 */
export async function promiseToPayWorkflow(
  input: PromiseToPayWorkflowInput,
): Promise<PromiseToPayWorkflowOutput> {
  const info = workflowInfo();
  const actCtx = {
    tenantId: input.tenantId,
    caseId: input.caseId,
    workflowId: info.workflowId,
    runId: info.runId,
    traceparent: input.traceparent,
  };

  let isPaid = false;
  let paymentId: string | undefined;
  let isDisputed = false;
  let isStopped = false;
  let stopReason: string | undefined;

  // Signal handlers
  setHandler(invoicePaidSignal, (payload: InvoicePaidSignalPayload) => {
    isPaid = true;
    paymentId = payload.paymentId;
  });

  setHandler(
    externalPaymentSucceededSignal,
    () => {
      isPaid = true;
    },
  );

  setHandler(disputeOpenedSignal, () => {
    isDisputed = true;
  });

  setHandler(stopSignal, (payload) => {
    isStopped = true;
    stopReason = payload?.reason;
  });

  // 1. Create PTP record in DB (activity supplies default date + wait when omitted)
  const createdPtp = await activities.createPromiseToPay({
    ...actCtx,
    promisedAmountMinor: input.promisedAmountMinor,
    currency: input.currency,
    promisedByDate: input.promisedByDate,
    gracePeriodHours: input.gracePeriodHours,
  });

  const promiseId = createdPtp.promiseId;

  await activities.emitMetric({
    ...actCtx,
    metricName: "ptp_created_total",
    labels: { result: "MADE" },
  });

  // 2. Wait until promised_by_date + grace (audit s-24 fix): delay is computed
  // inside createPromiseToPay from promised_by_date + 24h grace (activity time),
  // NOT from fixed metadata.ptpWaitDelay. Fall back to legacy metadata override
  // only when the activity mock predates the fix (tests), else "24h".
  const waitDelay =
    (createdPtp as { waitDelay?: string }).waitDelay ??
    (input.metadata?.ptpWaitDelay as string | undefined) ??
    "24h";

  await condition(() => isPaid || isDisputed || isStopped, waitDelay);

  // 3. Check reactive signal outcomes
  if (isPaid) {
    const resolved = await activities.resolvePromiseToPay({
      ...actCtx,
      promiseId,
      status: "HONORED",
      honoredPaymentId: paymentId,
    });

    await activities.emitMetric({
      ...actCtx,
      metricName: "ptp_outcome_total",
      labels: { result: "HONORED" },
    });

    await activities.emitMetric({
      ...actCtx,
      metricName: "ptp_completion_total",
      labels: { status: "COMPLETED" },
    });

    return {
      status: "HONORED",
      promiseId,
      paymentId,
      resolvedAt: resolved.resolvedAt,
    };
  }

  if (isDisputed) {
    // Close the DB row (s-24 fix): domain allows MADE->BROKEN only, so a
    // disputed promise resolves to BROKEN to avoid orphan MADE rows that
    // pollute findOverduePromises/metrics. Workflow output stays DISPUTED.
    await activities.resolvePromiseToPay({
      ...actCtx,
      promiseId,
      status: "BROKEN",
    });
    return {
      status: "DISPUTED",
      promiseId,
      reason: "DISPUTE_OPENED",
    };
  }

  if (isStopped) {
    await activities.resolvePromiseToPay({
      ...actCtx,
      promiseId,
      status: "BROKEN",
    });
    return {
      status: "STOPPED",
      promiseId,
      reason: stopReason ?? "STOP_SIGNAL_RECEIVED",
    };
  }

  // 4. Timer expired: check fresh DB state for settled payment before breaking
  const invoiceStatus = await activities.checkInvoiceStatus({
    ...actCtx,
    invoiceId: input.invoiceId,
  });

  if (invoiceStatus.isPaid) {
    const resolved = await activities.resolvePromiseToPay({
      ...actCtx,
      promiseId,
      status: "HONORED",
      honoredPaymentId: paymentId,
    });

    await activities.emitMetric({
      ...actCtx,
      metricName: "ptp_outcome_total",
      labels: { result: "HONORED" },
    });

    await activities.emitMetric({
      ...actCtx,
      metricName: "ptp_completion_total",
      labels: { status: "COMPLETED" },
    });

    return {
      status: "HONORED",
      promiseId,
      resolvedAt: resolved.resolvedAt,
    };
  }

  if (invoiceStatus.isDisputed) {
    await activities.resolvePromiseToPay({
      ...actCtx,
      promiseId,
      status: "BROKEN",
    });
    return {
      status: "DISPUTED",
      promiseId,
      reason: "INVOICE_DISPUTED_IN_DB",
    };
  }

  // 5. Unpaid: transition to BROKEN or EXPIRED
  const isExpired = input.metadata?.forceExpire === true;
  const targetStatus = isExpired ? "EXPIRED" : "BROKEN";

  const resolved = await activities.resolvePromiseToPay({
    ...actCtx,
    promiseId,
    status: targetStatus,
  });

  await activities.emitMetric({
    ...actCtx,
    metricName: "ptp_outcome_total",
    labels: { result: targetStatus },
  });

  return {
    status: targetStatus,
    promiseId,
    resolvedAt: resolved.resolvedAt,
    reason: isExpired ? "PROMISE_EXPIRED" : "PROMISE_BROKEN",
  };
}

// Aliases
export const PromiseToPayWorkflow = promiseToPayWorkflow;
