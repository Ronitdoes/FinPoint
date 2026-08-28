export * from "./load-case-snapshot";
export * from "./check-policy-again";
export * from "./execute-retry-payment";
export * from "./create-payment-link";
export * from "./send-template-message";
export * from "./refresh-payment-status";
export * from "./record-outcome";
export * from "./create-human-task";
export * from "./wait-for-human-decision";
export * from "./mark-case-waiting";
export * from "./mark-case-in-progress";
export * from "./stop-case-with-reason";
export * from "./append-timeline";
export * from "./emit-metric";
export * from "./escalate-workflow-failure";
export * from "./replan-decision";

import * as loadCaseSnapshotActivity from "./load-case-snapshot";
import * as checkPolicyAgainActivity from "./check-policy-again";
import * as executeRetryPaymentActivity from "./execute-retry-payment";
import * as createPaymentLinkActivity from "./create-payment-link";
import * as sendTemplateMessageActivity from "./send-template-message";
import * as refreshPaymentStatusActivity from "./refresh-payment-status";
import * as recordOutcomeActivity from "./record-outcome";
import * as createHumanTaskActivity from "./create-human-task";
import * as waitForHumanDecisionActivity from "./wait-for-human-decision";
import * as markCaseWaitingActivity from "./mark-case-waiting";
import * as markCaseInProgressActivity from "./mark-case-in-progress";
import * as stopCaseWithReasonActivity from "./stop-case-with-reason";
import * as appendTimelineActivity from "./append-timeline";
import * as emitMetricActivity from "./emit-metric";
import * as escalateWorkflowFailureActivity from "./escalate-workflow-failure";
import * as replanDecisionActivity from "./replan-decision";

/**
 * Complete activities dictionary for Temporal worker registration and proxyActivities typing.
 */
export const activities = {
  loadCaseSnapshot: loadCaseSnapshotActivity.loadCaseSnapshot,
  checkPolicyAgain: checkPolicyAgainActivity.checkPolicyAgain,
  executeRetryPayment: executeRetryPaymentActivity.executeRetryPayment,
  createPaymentLinkAndStore: createPaymentLinkActivity.createPaymentLinkAndStore,
  sendTemplateMessage: sendTemplateMessageActivity.sendTemplateMessage,
  refreshPaymentStatus: refreshPaymentStatusActivity.refreshPaymentStatus,
  recordOutcome: recordOutcomeActivity.recordOutcome,
  createHumanTask: createHumanTaskActivity.createHumanTask,
  waitForHumanDecision: waitForHumanDecisionActivity.waitForHumanDecision,
  markCaseWaiting: markCaseWaitingActivity.markCaseWaiting,
  markCaseInProgress: markCaseInProgressActivity.markCaseInProgress,
  stopCaseWithReason: stopCaseWithReasonActivity.stopCaseWithReason,
  appendTimeline: appendTimelineActivity.appendTimeline,
  emitMetric: emitMetricActivity.emitMetric,
  escalateWorkflowFailure: escalateWorkflowFailureActivity.escalateWorkflowFailure,
  requestReplanDecision: replanDecisionActivity.requestReplanDecision,
};

export type RecoveryActivities = typeof activities;
