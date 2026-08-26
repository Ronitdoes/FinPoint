import { describe, expect, it } from "vitest";

import { ACTION_STATUSES } from "./action-status";
import { ACTION_TYPES } from "./action-type";
import { ACTOR_TYPES } from "./actor-type";
import { CASE_EVENT_TYPES } from "./case-event-type";
import { CASE_STATUSES } from "./case-status";
import { CHANNELS } from "./channel";
import { CUSTOMER_RESPONSE_TYPES } from "./customer-response-type";
import { CUSTOMER_STATUSES } from "./customer-status";
import { DECISION_STATUSES } from "./decision-status";
import { EVENT_SOURCES } from "./event-source";
import { EVENT_STATUSES } from "./event-status";
import {
  CHECKOUT_EVENT_TYPES,
  CUSTOMER_EVENT_TYPES,
  EVENT_TYPES,
  INVOICE_EVENT_TYPES,
  PAYMENT_EVENT_TYPES,
  SUBSCRIPTION_EVENT_TYPES,
} from "./event-type";
import { HUMAN_TASK_PRIORITIES } from "./human-task-priority";
import { HUMAN_TASK_STATUSES } from "./human-task-status";
import { HUMAN_TASK_TYPES } from "./human-task-type";
import { IDEMPOTENCY_KEY_STATUSES } from "./idempotency-key-status";
import { INVOICE_STATUSES } from "./invoice-status";
import { MESSAGE_DIRECTIONS } from "./message-direction";
import { MESSAGE_STATUSES } from "./message-status";
import { MESSAGING_PROVIDERS } from "./messaging-provider";
import { PAYMENT_ATTEMPT_INITIATED_BY } from "./payment-attempt-initiated-by";
import { PAYMENT_ATTEMPT_STATUSES } from "./payment-attempt-status";
import { CHECKOUT_STATUSES } from "./checkout-status";
import { PAYMENT_STATUSES } from "./payment-status";
import { POLICY_RESULTS } from "./policy-result";
import { POLICY_RULE_KINDS } from "./policy-rule-kind";
import { PROMISE_TO_PAY_STATUSES } from "./promise-to-pay-status";
import { PROVIDERS } from "./provider";
import { RECOVERY_COST_CATEGORIES } from "./recovery-cost-category";
import { RISK_BANDS } from "./risk-band";
import { RISK_STATUSES } from "./risk-status";
import { RISK_TYPES } from "./risk-type";
import { STOP_CONDITIONS } from "./stop-condition";
import { SUBSCRIPTION_STATUSES } from "./subscription-status";
import { TENANT_STATUSES } from "./tenant-status";
import { USER_ROLES } from "./user-role";
import { USER_STATUSES } from "./user-status";
import { WORKFLOW_STATUSES } from "./workflow-status";

const SPEC_ENUMS = {
  caseStatuses: [
    "DETECTED",
    "QUALIFIED",
    "DECISION_PENDING",
    "POLICY_REVIEW",
    "IN_PROGRESS",
    "WAITING",
    "RECOVERED",
    "STOPPED",
    "ESCALATED",
    "FAILED",
  ],
  riskTypes: ["PAYMENT_FAILURE", "CHECKOUT_ABANDONMENT", "INVOICE_OVERDUE"],
  riskBands: ["LOW", "MEDIUM", "HIGH", "CRITICAL"],
  paymentStatuses: [
    "CREATED",
    "PENDING",
    "FAILED",
    "SUCCEEDED",
    "REFUNDED",
    "DISPUTED",
  ],
  checkoutStatuses: [
    "STARTED",
    "PAYMENT_STARTED",
    "COMPLETED",
    "ABANDONED",
    "EXPIRED",
  ],
  invoiceStatuses: [
    "DRAFT",
    "SENT",
    "DUE",
    "OVERDUE",
    "PAID",
    "DISPUTED",
    "CANCELLED",
  ],
  actionTypes: [
    "RETRY_PAYMENT",
    "CREATE_PAYMENT_LINK",
    "SEND_EMAIL",
    "SEND_WHATSAPP",
    "SEND_SMS",
    "OFFER_INCENTIVE",
    "REQUEST_PAYMENT_METHOD_UPDATE",
    "CREATE_PROMISE_TO_PAY",
    "CREATE_HUMAN_TASK",
    "PAUSE_CASE",
    "STOP_CASE",
  ],
  channels: ["WHATSAPP", "EMAIL", "SMS"],
  actorTypes: ["SYSTEM", "AI", "USER", "WORKFLOW", "PROVIDER"],
  stopConditions: [
    "PAYMENT_SUCCEEDED",
    "OPTED_OUT",
    "MAX_RETRIES",
    "DISPUTED",
    "POLICY_STOP",
    "PROMISE_MADE",
    "MANUAL_STOP",
    "ATTRIBUTION_WINDOW_EXPIRED",
  ],
  tenantStatuses: ["ACTIVE", "SUSPENDED"],
  userRoles: ["ADMIN", "FINANCE", "OPERATIONS", "SUPPORT", "VIEWER"],
  userStatuses: ["ACTIVE", "DISABLED"],
  customerStatuses: ["ACTIVE", "CHURNED", "BLOCKED"],
  providers: ["STRIPE", "RAZORPAY", "MOCK"],
  paymentAttemptInitiatedBy: ["PROVIDER_AUTO", "RECOVERY_WORKFLOW", "MANUAL"],
  paymentAttemptStatuses: ["REQUESTED", "SUCCEEDED", "FAILED", "UNKNOWN"],
  subscriptionStatuses: ["ACTIVE", "PAST_DUE", "PAUSED", "CANCELLED", "INCOMPLETE"],
  eventSources: ["STRIPE", "RAZORPAY", "INTERNAL"],
  eventStatuses: ["RECEIVED", "PROCESSING", "PROCESSED", "FAILED"],
  riskStatuses: ["OPEN", "ASSESSED", "EXPIRED"],
  decisionStatuses: [
    "COMPLETED",
    "INVALID_OUTPUT",
    "FALLBACK_RULE_BASED",
    "FAILED",
    "POLICY_REJECTED",
  ],
  actionStatuses: [
    "PROPOSED",
    "APPROVAL_REQUIRED",
    "APPROVED",
    "POLICY_REJECTED",
    "EXECUTING",
    "EXECUTED",
    "FAILED",
    "CANCELLED",
    "SKIPPED",
  ],
  workflowStatuses: [
    "RUNNING",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "CONTINUED_AS_NEW",
  ],
  messageDirections: ["OUTBOUND", "INBOUND"],
  messagingProviders: ["WHATSAPP_CLOUD", "SMTP_EMAIL", "MOCK"],
  messageStatuses: [
    "QUEUED",
    "SENT",
    "DELIVERED",
    "READ",
    "FAILED",
    "BOUNCED",
    "REJECTED",
  ],
  customerResponseTypes: [
    "REPLY",
    "OPT_OUT",
    "PROMISE_TO_PAY",
    "COMPLAINT",
    "OTHER",
  ],
  promiseToPayStatuses: ["MADE", "HONORED", "BROKEN", "EXPIRED"],
  humanTaskTypes: [
    "APPROVAL",
    "DISPUTE_REVIEW",
    "COMPLIANCE_REVIEW",
    "WORKFLOW_FAILURE",
    "GENERAL",
  ],
  humanTaskPriorities: ["LOW", "MEDIUM", "HIGH", "URGENT"],
  humanTaskStatuses: [
    "PENDING",
    "ASSIGNED",
    "APPROVED",
    "REJECTED",
    "RESOLVED",
    "CANCELLED",
  ],
  policyRuleKinds: ["REJECT", "REQUIRE_APPROVAL", "LIMIT"],
  policyResults: ["ALLOWED", "REJECTED", "REQUIRE_APPROVAL"],
  recoveryCostCategories: [
    "LLM",
    "MESSAGING",
    "PAYMENT_PROCESSING",
    "DISCOUNT",
    "MANUAL_HANDLING",
    "PROVIDER",
  ],
  idempotencyKeyStatuses: ["PROCESSING", "COMPLETED", "FAILED"],
} as const;

const SPEC_PAYMENT_EVENTS = [
  "payment.created",
  "payment.pending",
  "payment.failed",
  "payment.succeeded",
  "payment.refunded",
  "payment.disputed",
] as const;

const SPEC_CHECKOUT_EVENTS = [
  "checkout.started",
  "checkout.item_added",
  "checkout.payment_started",
  "checkout.abandoned",
  "checkout.completed",
] as const;

const SPEC_SUBSCRIPTION_EVENTS = [
  "subscription.created",
  "subscription.payment_failed",
  "subscription.renewed",
  "subscription.cancelled",
] as const;

const SPEC_INVOICE_EVENTS = [
  "invoice.created",
  "invoice.due",
  "invoice.overdue",
  "invoice.paid",
  "invoice.disputed",
] as const;

const SPEC_CUSTOMER_EVENTS = [
  "customer.replied",
  "customer.opted_out",
  "customer.payment_method_changed",
  "customer_promised_to_pay",
  "customer_payment_received",
] as const;

function expectParity(actual: readonly string[], spec: readonly string[]): void {
  expect([...actual].sort()).toEqual([...spec].sort());
}

describe("enum parity with specs (drift guard)", () => {
  it("case statuses match spec 01 §1/§12 verbatim", () => {
    expectParity(CASE_STATUSES, SPEC_ENUMS.caseStatuses);
  });

  it("risk types match the three MVP surfaces (spec 02 §5 detection triggers)", () => {
    expectParity(RISK_TYPES, SPEC_ENUMS.riskTypes);
  });

  it("risk bands stay the four canonical bands", () => {
    expectParity(RISK_BANDS, SPEC_ENUMS.riskBands);
  });

  it("payment/checkout/invoice statuses match s-03 enum list verbatim", () => {
    expectParity(PAYMENT_STATUSES, SPEC_ENUMS.paymentStatuses);
    expectParity(CHECKOUT_STATUSES, SPEC_ENUMS.checkoutStatuses);
    expectParity(INVOICE_STATUSES, SPEC_ENUMS.invoiceStatuses);
  });

  it("action catalog matches spec 02 §6 verbatim", () => {
    expectParity(ACTION_TYPES, SPEC_ENUMS.actionTypes);
  });

  it("channels and actor types stay fixed to their enum lists", () => {
    expectParity(CHANNELS, SPEC_ENUMS.channels);
    expectParity(ACTOR_TYPES, SPEC_ENUMS.actorTypes);
  });

  it("stop conditions match the s-03 closed set", () => {
    expectParity(STOP_CONDITIONS, SPEC_ENUMS.stopConditions);
  });

  it("event taxonomy partitions spec 02 §5 exactly", () => {
    expectParity(PAYMENT_EVENT_TYPES, SPEC_PAYMENT_EVENTS);
    expectParity(CHECKOUT_EVENT_TYPES, SPEC_CHECKOUT_EVENTS);
    expectParity(SUBSCRIPTION_EVENT_TYPES, SPEC_SUBSCRIPTION_EVENTS);
    expectParity(INVOICE_EVENT_TYPES, SPEC_INVOICE_EVENTS);
    expectParity(CUSTOMER_EVENT_TYPES, SPEC_CUSTOMER_EVENTS);

    const partition = [
      ...PAYMENT_EVENT_TYPES,
      ...CHECKOUT_EVENT_TYPES,
      ...SUBSCRIPTION_EVENT_TYPES,
      ...INVOICE_EVENT_TYPES,
      ...CUSTOMER_EVENT_TYPES,
    ];
    expect(partition).toHaveLength(new Set(partition).size);
    expectParity(EVENT_TYPES, [...partition]);
  });

  it("case event types match the spec 01 §17 timeline vocabulary", () => {
    expectParity(CASE_EVENT_TYPES, [
      "PAYMENT_FAILED",
      "RISK_CALCULATED",
      "AI_DECISION_CREATED",
      "POLICY_ALLOWED",
      "POLICY_REJECTED",
      "WORKFLOW_STARTED",
      "WHATSAPP_SENT",
      "EMAIL_SENT",
      "PAYMENT_RETRY_STARTED",
      "PAYMENT_SUCCEEDED",
      "RECOVERY_RECORDED",
      "HUMAN_TASK_CREATED",
      "HUMAN_DECISION_RECORDED",
      "CASE_PAUSED",
      "CASE_RESUMED",
      "CASE_ESCALATED",
      "CASE_STOPPED",
    ]);
  });

  it("financial core enums match s-04 enum definitions verbatim", () => {
    expectParity(TENANT_STATUSES, SPEC_ENUMS.tenantStatuses);
    expectParity(USER_ROLES, SPEC_ENUMS.userRoles);
    expectParity(USER_STATUSES, SPEC_ENUMS.userStatuses);
    expectParity(CUSTOMER_STATUSES, SPEC_ENUMS.customerStatuses);
    expectParity(PROVIDERS, SPEC_ENUMS.providers);
    expectParity(PAYMENT_ATTEMPT_INITIATED_BY, SPEC_ENUMS.paymentAttemptInitiatedBy);
    expectParity(PAYMENT_ATTEMPT_STATUSES, SPEC_ENUMS.paymentAttemptStatuses);
    expectParity(SUBSCRIPTION_STATUSES, SPEC_ENUMS.subscriptionStatuses);
  });

  it("recovery domain enums match s-05 enum definitions verbatim", () => {
    expectParity(EVENT_SOURCES, SPEC_ENUMS.eventSources);
    expectParity(EVENT_STATUSES, SPEC_ENUMS.eventStatuses);
    expectParity(RISK_STATUSES, SPEC_ENUMS.riskStatuses);
    expectParity(DECISION_STATUSES, SPEC_ENUMS.decisionStatuses);
    expectParity(ACTION_STATUSES, SPEC_ENUMS.actionStatuses);
    expectParity(WORKFLOW_STATUSES, SPEC_ENUMS.workflowStatuses);
    expectParity(MESSAGE_DIRECTIONS, SPEC_ENUMS.messageDirections);
    expectParity(MESSAGING_PROVIDERS, SPEC_ENUMS.messagingProviders);
    expectParity(MESSAGE_STATUSES, SPEC_ENUMS.messageStatuses);
    expectParity(CUSTOMER_RESPONSE_TYPES, SPEC_ENUMS.customerResponseTypes);
    expectParity(PROMISE_TO_PAY_STATUSES, SPEC_ENUMS.promiseToPayStatuses);
    expectParity(HUMAN_TASK_TYPES, SPEC_ENUMS.humanTaskTypes);
    expectParity(HUMAN_TASK_PRIORITIES, SPEC_ENUMS.humanTaskPriorities);
    expectParity(HUMAN_TASK_STATUSES, SPEC_ENUMS.humanTaskStatuses);
    expectParity(POLICY_RULE_KINDS, SPEC_ENUMS.policyRuleKinds);
    expectParity(POLICY_RESULTS, SPEC_ENUMS.policyResults);
    expectParity(RECOVERY_COST_CATEGORIES, SPEC_ENUMS.recoveryCostCategories);
    expectParity(IDEMPOTENCY_KEY_STATUSES, SPEC_ENUMS.idempotencyKeyStatuses);
  });
});
