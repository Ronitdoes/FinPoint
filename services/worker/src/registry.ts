import { activities, type RecoveryActivities } from "./activities";
import { recoveryWorkflowTemplate } from "./workflows/_template";
import { failedPaymentRecoveryWorkflow } from "./workflows/failed-payment";
import { checkoutAbandonmentWorkflow } from "./workflows/checkout-abandonment";
import { invoiceOverdueWorkflow } from "./workflows/invoice-overdue";
import { promiseToPayWorkflow } from "./workflows/promise-to-pay";

/**
 * Registry of all available Temporal Workflows in the recovery worker.
 *
 * s-20 foundation: recoveryWorkflowTemplate (+ shared.ts signals/queries).
 * Later additions (s-22/23/24): failed-payment, checkout-abandonment,
 * invoice-overdue, promise-to-pay. Aliased PascalCase keys preserve
 * backward compatibility with earlier workflow-type strings.
 */
export const WORKFLOWS = {
  recoveryWorkflowTemplate,
  failedPaymentRecoveryWorkflow,
  FailedPaymentRecoveryWorkflow: failedPaymentRecoveryWorkflow,
  checkoutAbandonmentWorkflow,
  CheckoutAbandonmentWorkflow: checkoutAbandonmentWorkflow,
  CheckoutRecoveryWorkflow: checkoutAbandonmentWorkflow,
  invoiceOverdueWorkflow,
  InvoiceOverdueWorkflow: invoiceOverdueWorkflow,
  OverdueInvoiceWorkflow: invoiceOverdueWorkflow,
  InvoiceRecoveryWorkflow: invoiceOverdueWorkflow,
  promiseToPayWorkflow,
  PromiseToPayWorkflow: promiseToPayWorkflow,
} as const;

/**
 * Registry of all available Temporal Activities.
 *
 * s-20 foundation (15 shared activities): loadCaseSnapshot, checkPolicyAgain,
 * executeRetryPayment, createPaymentLinkAndStore, sendTemplateMessage,
 * refreshPaymentStatus, recordOutcome, createHumanTask, waitForHumanDecision,
 * markCaseWaiting, markCaseInProgress, stopCaseWithReason, appendTimeline,
 * emitMetric, escalateWorkflowFailure.
 * Later additions (s-22/23/24 + replan): requestReplanDecision,
 * checkCheckoutStatus, confirmAbandonmentAndCreateCase, checkoutRaceGuard,
 * checkInvoiceStatus, createPromiseToPay, resolvePromiseToPay.
 */
export const ACTIVITIES: RecoveryActivities = activities;

export type RegisteredWorkflowName = keyof typeof WORKFLOWS;
export type RegisteredActivityName = keyof typeof ACTIVITIES;
