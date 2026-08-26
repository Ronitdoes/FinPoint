declare const brand: unique symbol;

type Brand<T extends string, B extends string> = T & {
  readonly [brand]: B;
};

export type EventId = Brand<string, "EventId">;
export type CorrelationId = Brand<string, "CorrelationId">;
export type TenantId = Brand<string, "TenantId">;
export type CustomerId = Brand<string, "CustomerId">;
export type PaymentId = Brand<string, "PaymentId">;
export type PaymentAttemptId = Brand<string, "PaymentAttemptId">;
export type SubscriptionId = Brand<string, "SubscriptionId">;
export type CheckoutId = Brand<string, "CheckoutId">;
export type InvoiceId = Brand<string, "InvoiceId">;
export type RevenueRiskId = Brand<string, "RevenueRiskId">;
export type RecoveryCaseId = Brand<string, "RecoveryCaseId">;
export type RecoveryActionId = Brand<string, "RecoveryActionId">;
export type AiDecisionId = Brand<string, "AiDecisionId">;
export type WorkflowId = Brand<string, "WorkflowId">;
export type MessageId = Brand<string, "MessageId">;
export type PromiseToPayId = Brand<string, "PromiseToPayId">;
export type HumanTaskId = Brand<string, "HumanTaskId">;
export type PolicyRuleId = Brand<string, "PolicyRuleId">;
export type AuditLogId = Brand<string, "AuditLogId">;
export type RecoveryOutcomeId = Brand<string, "RecoveryOutcomeId">;

export function eventId(value: string): EventId {
  return value as EventId;
}
export function correlationId(value: string): CorrelationId {
  return value as CorrelationId;
}
export function tenantId(value: string): TenantId {
  return value as TenantId;
}
export function customerId(value: string): CustomerId {
  return value as CustomerId;
}
export function paymentId(value: string): PaymentId {
  return value as PaymentId;
}
export function paymentAttemptId(value: string): PaymentAttemptId {
  return value as PaymentAttemptId;
}
export function subscriptionId(value: string): SubscriptionId {
  return value as SubscriptionId;
}
export function checkoutId(value: string): CheckoutId {
  return value as CheckoutId;
}
export function invoiceId(value: string): InvoiceId {
  return value as InvoiceId;
}
export function revenueRiskId(value: string): RevenueRiskId {
  return value as RevenueRiskId;
}
export function recoveryCaseId(value: string): RecoveryCaseId {
  return value as RecoveryCaseId;
}
export function recoveryActionId(value: string): RecoveryActionId {
  return value as RecoveryActionId;
}
export function aiDecisionId(value: string): AiDecisionId {
  return value as AiDecisionId;
}
export function workflowId(value: string): WorkflowId {
  return value as WorkflowId;
}
export function messageId(value: string): MessageId {
  return value as MessageId;
}
export function promiseToPayId(value: string): PromiseToPayId {
  return value as PromiseToPayId;
}
export function humanTaskId(value: string): HumanTaskId {
  return value as HumanTaskId;
}
export function policyRuleId(value: string): PolicyRuleId {
  return value as PolicyRuleId;
}
export function auditLogId(value: string): AuditLogId {
  return value as AuditLogId;
}
export function recoveryOutcomeId(value: string): RecoveryOutcomeId {
  return value as RecoveryOutcomeId;
}
