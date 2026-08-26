import { describe, expect, it } from "vitest";
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
import {
  actionStatusEnum,
  actionTypeEnum,
  actorTypeEnum,
  caseStatusEnum,
  channelEnum,
  checkoutStatusEnum,
  customerResponseTypeEnum,
  customerStatusEnum,
  decisionStatusEnum,
  eventSourceEnum,
  eventStatusEnum,
  eventTypeEnum,
  humanTaskPriorityEnum,
  humanTaskStatusEnum,
  humanTaskTypeEnum,
  idempotencyKeyStatusEnum,
  invoiceStatusEnum,
  messageDirectionEnum,
  messageStatusEnum,
  messagingProviderEnum,
  paymentAttemptInitiatedByEnum,
  paymentAttemptStatusEnum,
  paymentStatusEnum,
  policyResultEnum,
  policyRuleKindEnum,
  promiseToPayStatusEnum,
  providerEnum,
  recoveryCostCategoryEnum,
  riskBandEnum,
  riskStatusEnum,
  riskTypeEnum,
  subscriptionStatusEnum,
  tenantStatusEnum,
  userRoleEnum,
  userStatusEnum,
  workflowStatusEnum,
} from "./enums";

function assertEnumParity(
  dbEnum: { enumValues: readonly string[] },
  domainValues: readonly string[],
) {
  expect([...dbEnum.enumValues].sort()).toEqual([...domainValues].sort());
}

describe("PostgreSQL enum parity with @repo/domain", () => {
  // Financial core enums (s-04)
  it("tenantStatusEnum matches TENANT_STATUSES", () => {
    assertEnumParity(tenantStatusEnum, TENANT_STATUSES);
  });

  it("userRoleEnum matches USER_ROLES", () => {
    assertEnumParity(userRoleEnum, USER_ROLES);
  });

  it("userStatusEnum matches USER_STATUSES", () => {
    assertEnumParity(userStatusEnum, USER_STATUSES);
  });

  it("customerStatusEnum matches CUSTOMER_STATUSES", () => {
    assertEnumParity(customerStatusEnum, CUSTOMER_STATUSES);
  });

  it("paymentStatusEnum matches PAYMENT_STATUSES", () => {
    assertEnumParity(paymentStatusEnum, PAYMENT_STATUSES);
  });

  it("providerEnum matches PROVIDERS", () => {
    assertEnumParity(providerEnum, PROVIDERS);
  });

  it("paymentAttemptInitiatedByEnum matches PAYMENT_ATTEMPT_INITIATED_BY", () => {
    assertEnumParity(
      paymentAttemptInitiatedByEnum,
      PAYMENT_ATTEMPT_INITIATED_BY,
    );
  });

  it("paymentAttemptStatusEnum matches PAYMENT_ATTEMPT_STATUSES", () => {
    assertEnumParity(paymentAttemptStatusEnum, PAYMENT_ATTEMPT_STATUSES);
  });

  it("subscriptionStatusEnum matches SUBSCRIPTION_STATUSES", () => {
    assertEnumParity(subscriptionStatusEnum, SUBSCRIPTION_STATUSES);
  });

  it("checkoutStatusEnum matches CHECKOUT_STATUSES", () => {
    assertEnumParity(checkoutStatusEnum, CHECKOUT_STATUSES);
  });

  it("invoiceStatusEnum matches INVOICE_STATUSES", () => {
    assertEnumParity(invoiceStatusEnum, INVOICE_STATUSES);
  });

  // Recovery domain enums (s-05)
  it("eventSourceEnum matches EVENT_SOURCES", () => {
    assertEnumParity(eventSourceEnum, EVENT_SOURCES);
  });

  it("eventStatusEnum matches EVENT_STATUSES", () => {
    assertEnumParity(eventStatusEnum, EVENT_STATUSES);
  });

  it("eventTypeEnum matches EVENT_TYPES", () => {
    assertEnumParity(eventTypeEnum, EVENT_TYPES);
  });

  it("riskTypeEnum matches RISK_TYPES", () => {
    assertEnumParity(riskTypeEnum, RISK_TYPES);
  });

  it("riskBandEnum matches RISK_BANDS", () => {
    assertEnumParity(riskBandEnum, RISK_BANDS);
  });

  it("riskStatusEnum matches RISK_STATUSES", () => {
    assertEnumParity(riskStatusEnum, RISK_STATUSES);
  });

  it("caseStatusEnum matches CASE_STATUSES", () => {
    assertEnumParity(caseStatusEnum, CASE_STATUSES);
  });

  it("decisionStatusEnum matches DECISION_STATUSES", () => {
    assertEnumParity(decisionStatusEnum, DECISION_STATUSES);
  });

  it("actionTypeEnum matches ACTION_TYPES", () => {
    assertEnumParity(actionTypeEnum, ACTION_TYPES);
  });

  it("actionStatusEnum matches ACTION_STATUSES", () => {
    assertEnumParity(actionStatusEnum, ACTION_STATUSES);
  });

  it("workflowStatusEnum matches WORKFLOW_STATUSES", () => {
    assertEnumParity(workflowStatusEnum, WORKFLOW_STATUSES);
  });

  it("channelEnum matches CHANNELS", () => {
    assertEnumParity(channelEnum, CHANNELS);
  });

  it("messageDirectionEnum matches MESSAGE_DIRECTIONS", () => {
    assertEnumParity(messageDirectionEnum, MESSAGE_DIRECTIONS);
  });

  it("messagingProviderEnum matches MESSAGING_PROVIDERS", () => {
    assertEnumParity(messagingProviderEnum, MESSAGING_PROVIDERS);
  });

  it("messageStatusEnum matches MESSAGE_STATUSES", () => {
    assertEnumParity(messageStatusEnum, MESSAGE_STATUSES);
  });

  it("customerResponseTypeEnum matches CUSTOMER_RESPONSE_TYPES", () => {
    assertEnumParity(customerResponseTypeEnum, CUSTOMER_RESPONSE_TYPES);
  });

  it("promiseToPayStatusEnum matches PROMISE_TO_PAY_STATUSES", () => {
    assertEnumParity(promiseToPayStatusEnum, PROMISE_TO_PAY_STATUSES);
  });

  it("humanTaskTypeEnum matches HUMAN_TASK_TYPES", () => {
    assertEnumParity(humanTaskTypeEnum, HUMAN_TASK_TYPES);
  });

  it("humanTaskPriorityEnum matches HUMAN_TASK_PRIORITIES", () => {
    assertEnumParity(humanTaskPriorityEnum, HUMAN_TASK_PRIORITIES);
  });

  it("humanTaskStatusEnum matches HUMAN_TASK_STATUSES", () => {
    assertEnumParity(humanTaskStatusEnum, HUMAN_TASK_STATUSES);
  });

  it("policyRuleKindEnum matches POLICY_RULE_KINDS", () => {
    assertEnumParity(policyRuleKindEnum, POLICY_RULE_KINDS);
  });

  it("policyResultEnum matches POLICY_RESULTS", () => {
    assertEnumParity(policyResultEnum, POLICY_RESULTS);
  });

  it("actorTypeEnum matches ACTOR_TYPES", () => {
    assertEnumParity(actorTypeEnum, ACTOR_TYPES);
  });

  it("recoveryCostCategoryEnum matches RECOVERY_COST_CATEGORIES", () => {
    assertEnumParity(recoveryCostCategoryEnum, RECOVERY_COST_CATEGORIES);
  });

  it("idempotencyKeyStatusEnum matches IDEMPOTENCY_KEY_STATUSES", () => {
    assertEnumParity(idempotencyKeyStatusEnum, IDEMPOTENCY_KEY_STATUSES);
  });
});
