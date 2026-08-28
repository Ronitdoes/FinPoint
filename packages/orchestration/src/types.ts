import type { Database } from "@repo/db";

export type WorkflowSignal =
  | "pause"
  | "resume"
  | "stop"
  | "human-decision"
  | "external-payment-succeeded"
  | "external-checkout-completed"
  | string;

export interface StartWorkflowInput {
  tenantId: string;
  caseId: string;
  workflowType:
    | "FailedPaymentRecoveryWorkflow"
    | "CheckoutRecoveryWorkflow"
    | "InvoiceRecoveryWorkflow"
    | string;
  actions: unknown[];
  db?: Database;
}

export interface StartWorkflowResult {
  workflowId: string;
  temporalWorkflowId: string;
  accepted: boolean;
}

export interface SignalWorkflowInput {
  tenantId?: string;
  caseId: string;
  signal: WorkflowSignal;
  payload?: Record<string, unknown>;
  db?: Database;
}

export interface CancelWorkflowInput {
  tenantId?: string;
  caseId: string;
  reason?: string;
  db?: Database;
}
