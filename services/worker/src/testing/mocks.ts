import { randomUUID } from "node:crypto";
import type { RecoveryActivities } from "../activities";

export interface MockActivitySpy {
  calls: Record<string, unknown[][]>;
  reset(): void;
}

export function createActivityMocks(
  customOverrides: Partial<RecoveryActivities> = {},
): {
  mockActivities: RecoveryActivities;
  spy: MockActivitySpy;
} {
  const calls: Record<string, unknown[][]> = {};

  const recordCall = (name: string, args: unknown[]) => {
    if (!calls[name]) {
      calls[name] = [];
    }
    calls[name].push(args);
  };

  const spy: MockActivitySpy = {
    calls,
    reset() {
      for (const key of Object.keys(calls)) {
        delete calls[key];
      }
    },
  };

  const defaultMocks: RecoveryActivities = {
    async loadCaseSnapshot(input) {
      recordCall("loadCaseSnapshot", [input]);
      return {
        case: {
          id: input.caseId,
          tenantId: input.tenantId,
          caseNumber: 1001,
          customerId: "cust-1",
          riskId: "risk-1",
          status: "IN_PROGRESS",
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: "pay_123",
          amountAtRisk: BigInt(250000),
          currency: "INR",
          riskScore: 65,
          statusReason: null,
          stopConditions: [],
          assignedTo: null,
          workflowId: null,
          attributionWindowHours: 72,
          openedAt: new Date(),
          closedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        risk: null,
        customer: {
          id: "cust-1",
          tenantId: input.tenantId,
          externalRef: "stripe_cus_123",
          name: "Acme Customer",
          email: "customer@example.com",
          phone: "+919876543210",
          status: "ACTIVE",
          lifetimeValue: BigInt(500000),
          optedOut: false,
          optedOutAt: null,
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
        actions: [],
      };
    },

    async checkPolicyAgain(input) {
      recordCall("checkPolicyAgain", [input]);
      return {
        allowed: true,
        requiresApproval: false,
        ruleCode: "PASS",
        policyEvaluationId: randomUUID(),
      };
    },

    async executeRetryPayment(input) {
      recordCall("executeRetryPayment", [input]);
      return {
        status: "SUCCEEDED",
        attemptId: randomUUID(),
        paymentId: input.paymentId,
      };
    },

    async createPaymentLinkAndStore(input) {
      recordCall("createPaymentLinkAndStore", [input]);
      return {
        paymentLinkId: randomUUID(),
        url: "https://pay.mock.provider/link-123",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
    },

    async sendTemplateMessage(input) {
      recordCall("sendTemplateMessage", [input]);
      return {
        messageId: randomUUID(),
        externalMessageId: `msg_${randomUUID()}`,
        status: "SENT",
      };
    },

    async refreshPaymentStatus(input) {
      recordCall("refreshPaymentStatus", [input]);
      return {
        status: "SUCCEEDED",
        paymentId: input.paymentId,
        settledAt: new Date().toISOString(),
      };
    },

    async recordOutcome(input) {
      recordCall("recordOutcome", [input]);
      return {
        outcomeId: randomUUID(),
        outcome: input.outcome,
        resolvedAt: new Date().toISOString(),
      };
    },

    async createHumanTask(input) {
      recordCall("createHumanTask", [input]);
      return {
        taskId: randomUUID(),
        status: "PENDING",
        createdAt: new Date().toISOString(),
      };
    },

    async waitForHumanDecision(input) {
      recordCall("waitForHumanDecision", [input]);
      return {
        taskId: input.taskId,
        status: "APPROVED",
        approved: true,
        decidedBy: "operator@example.com",
        decidedAt: new Date().toISOString(),
      };
    },

    async markCaseWaiting(input) {
      recordCall("markCaseWaiting", [input]);
      return {
        success: true,
        status: "WAITING",
      };
    },

    async markCaseInProgress(input) {
      recordCall("markCaseInProgress", [input]);
      return {
        success: true,
        status: "IN_PROGRESS",
      };
    },

    async stopCaseWithReason(input) {
      recordCall("stopCaseWithReason", [input]);
      return {
        success: true,
        status: "STOPPED",
        stopReason: input.stopReason,
      };
    },

    async appendTimeline(input) {
      recordCall("appendTimeline", [input]);
      return {
        eventId: 101,
        occurredAt: new Date().toISOString(),
      };
    },

    async emitMetric(input) {
      recordCall("emitMetric", [input]);
      return {
        success: true,
      };
    },

    async escalateWorkflowFailure(input) {
      recordCall("escalateWorkflowFailure", [input]);
      return {
        success: true,
        taskId: randomUUID(),
      };
    },
  };

  const mockActivities: RecoveryActivities = {
    ...defaultMocks,
    ...customOverrides,
  };

  return { mockActivities, spy };
}
