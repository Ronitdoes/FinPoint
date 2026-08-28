import { activities, type RecoveryActivities } from "./activities";
import { recoveryWorkflowTemplate } from "./workflows/_template";
import { failedPaymentRecoveryWorkflow } from "./workflows/failed-payment";
import { checkoutAbandonmentWorkflow } from "./workflows/checkout-abandonment";
import { invoiceOverdueWorkflow } from "./workflows/invoice-overdue";
import { promiseToPayWorkflow } from "./workflows/promise-to-pay";

/**
 * Registry of all available Temporal Workflows in the recovery worker.
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
 */
export const ACTIVITIES: RecoveryActivities = activities;

export type RegisteredWorkflowName = keyof typeof WORKFLOWS;
export type RegisteredActivityName = keyof typeof ACTIVITIES;
