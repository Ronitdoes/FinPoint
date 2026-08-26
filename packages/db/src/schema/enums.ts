import { pgEnum } from "drizzle-orm/pg-core";
import {
  ACTION_STATUSES,
  ACTION_TYPES,
  ACTOR_TYPES,
  CASE_STATUSES,
  CHANNELS,
  CHECKOUT_STATUSES,
  CUSTOMER_RESPONSE_TYPES,
  CUSTOMER_STATUSES,
  DECISION_STATUSES,
  EVENT_SOURCES,
  EVENT_STATUSES,
  EVENT_TYPES,
  HUMAN_TASK_PRIORITIES,
  HUMAN_TASK_STATUSES,
  HUMAN_TASK_TYPES,
  IDEMPOTENCY_KEY_STATUSES,
  INVOICE_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  MESSAGING_PROVIDERS,
  PAYMENT_ATTEMPT_INITIATED_BY,
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_STATUSES,
  POLICY_RESULTS,
  POLICY_RULE_KINDS,
  PROMISE_TO_PAY_STATUSES,
  PROVIDERS,
  RECOVERY_COST_CATEGORIES,
  RISK_BANDS,
  RISK_STATUSES,
  RISK_TYPES,
  SUBSCRIPTION_STATUSES,
  TENANT_STATUSES,
  USER_ROLES,
  USER_STATUSES,
  WORKFLOW_STATUSES,
} from "@repo/domain";

/**
 * PostgreSQL enums mirroring @repo/domain closed enumerations.
 * Verified by enum parity unit tests to prevent schema drift.
 */
export const tenantStatusEnum = pgEnum("tenant_status", TENANT_STATUSES);
export const userRoleEnum = pgEnum("user_role", USER_ROLES);
export const userStatusEnum = pgEnum("user_status", USER_STATUSES);
export const customerStatusEnum = pgEnum("customer_status", CUSTOMER_STATUSES);
export const paymentStatusEnum = pgEnum("payment_status", PAYMENT_STATUSES);
export const providerEnum = pgEnum("provider", PROVIDERS);
export const paymentAttemptInitiatedByEnum = pgEnum(
  "payment_attempt_initiated_by",
  PAYMENT_ATTEMPT_INITIATED_BY,
);
export const paymentAttemptStatusEnum = pgEnum(
  "payment_attempt_status",
  PAYMENT_ATTEMPT_STATUSES,
);
export const subscriptionStatusEnum = pgEnum(
  "subscription_status",
  SUBSCRIPTION_STATUSES,
);
export const checkoutStatusEnum = pgEnum("checkout_status", CHECKOUT_STATUSES);
export const invoiceStatusEnum = pgEnum("invoice_status", INVOICE_STATUSES);

// Recovery domain enums (Step 05)
export const eventSourceEnum = pgEnum("event_source", EVENT_SOURCES);
export const eventStatusEnum = pgEnum("event_status", EVENT_STATUSES);
export const eventTypeEnum = pgEnum("event_type", EVENT_TYPES);
export const riskTypeEnum = pgEnum("risk_type", RISK_TYPES);
export const riskBandEnum = pgEnum("risk_band", RISK_BANDS);
export const riskStatusEnum = pgEnum("risk_status", RISK_STATUSES);
export const caseStatusEnum = pgEnum("case_status", CASE_STATUSES);
export const decisionStatusEnum = pgEnum("decision_status", DECISION_STATUSES);
export const actionTypeEnum = pgEnum("action_type", ACTION_TYPES);
export const actionStatusEnum = pgEnum("action_status", ACTION_STATUSES);
export const workflowStatusEnum = pgEnum("workflow_status", WORKFLOW_STATUSES);
export const channelEnum = pgEnum("channel", CHANNELS);
export const messageDirectionEnum = pgEnum("message_direction", MESSAGE_DIRECTIONS);
export const messagingProviderEnum = pgEnum("messaging_provider", MESSAGING_PROVIDERS);
export const messageStatusEnum = pgEnum("message_status", MESSAGE_STATUSES);
export const customerResponseTypeEnum = pgEnum(
  "customer_response_type",
  CUSTOMER_RESPONSE_TYPES,
);
export const promiseToPayStatusEnum = pgEnum(
  "promise_to_pay_status",
  PROMISE_TO_PAY_STATUSES,
);
export const humanTaskTypeEnum = pgEnum("human_task_type", HUMAN_TASK_TYPES);
export const humanTaskPriorityEnum = pgEnum(
  "human_task_priority",
  HUMAN_TASK_PRIORITIES,
);
export const humanTaskStatusEnum = pgEnum(
  "human_task_status",
  HUMAN_TASK_STATUSES,
);
export const policyRuleKindEnum = pgEnum("policy_rule_kind", POLICY_RULE_KINDS);
export const policyResultEnum = pgEnum("policy_result", POLICY_RESULTS);
export const actorTypeEnum = pgEnum("actor_type", ACTOR_TYPES);
export const recoveryCostCategoryEnum = pgEnum(
  "recovery_cost_category",
  RECOVERY_COST_CATEGORIES,
);
export const idempotencyKeyStatusEnum = pgEnum(
  "idempotency_key_status",
  IDEMPOTENCY_KEY_STATUSES,
);
