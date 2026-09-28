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

    async checkPolicyAgain() {
      return {
        allowed: true,
        requiresApproval: false,
        ruleCode: "PASS",
        policyEvaluationId: randomUUID(),
      };
    },

    async executeRetryPayment(input) {
      return {
        status: "SUCCEEDED",
        attemptId: randomUUID(),
        paymentId: input.paymentId,
      };
    },

    async createPaymentLinkAndStore() {
      return {
        paymentLinkId: randomUUID(),
        url: "https://pay.mock.provider/link-123",
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      };
    },

    async sendTemplateMessage() {
      return {
        messageId: randomUUID(),
        externalMessageId: `msg_${randomUUID()}`,
        status: "SENT",
      };
    },

    async refreshPaymentStatus(input) {
      return {
        status: "SUCCEEDED",
        paymentId: input.paymentId,
        settledAt: new Date().toISOString(),
      };
    },

    async recordOutcome(input) {
      return {
        outcomeId: randomUUID(),
        outcome: input.outcome,
        resolvedAt: new Date().toISOString(),
      };
    },

    async createHumanTask() {
      return {
        taskId: randomUUID(),
        status: "PENDING",
        createdAt: new Date().toISOString(),
      };
    },

    async waitForHumanDecision(input) {
      return {
        taskId: input.taskId,
        status: "APPROVED",
        approved: true,
        decidedBy: "operator@example.com",
        decidedAt: new Date().toISOString(),
      };
    },

    async markCaseWaiting() {
      return {
        success: true,
        status: "WAITING",
      };
    },

    async markCaseInProgress() {
      return {
        success: true,
        status: "IN_PROGRESS",
      };
    },

    async stopCaseWithReason(input) {
      return {
        success: true,
        status: "STOPPED",
        stopReason: input.stopReason,
      };
    },

    async appendTimeline() {
      return {
        eventId: 101,
        occurredAt: new Date().toISOString(),
      };
    },

    async emitMetric() {
      return {
        success: true,
      };
    },

    async escalateWorkflowFailure() {
      return {
        success: true,
        taskId: randomUUID(),
      };
    },

    async requestReplanDecision() {
      return {
        decisionId: randomUUID(),
        replanAction: "STOP_CASE",
        actions: [{ type: "STOP_CASE", parameters: { reason: "MAX_RETRIES" } }],
        stopReason: "MAX_RETRIES",
        diagnosis: "Max retries exhausted",
        allowed: true,
        requiresApproval: false,
      };
    },

    async checkCheckoutStatus() {
      return {
        exists: true,
        status: "STARTED",
        isCompleted: false,
        isAbandoned: true,
        cartValue: "799900",
        currency: "INR",
        customerId: "cust-1",
        lastActivityAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
        startedAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      };
    },

    async confirmAbandonmentAndCreateCase(input) {
      const caseId = randomUUID();
      return {
        isCompleted: false,
        caseId,
        caseNumber: 2001,
        riskScore: 75,
        riskBand: "HIGH",
        customerId: "cust-1",
        cartValueMinor: "799900",
        currency: "INR",
        reminderChannel: "WHATSAPP",
        reminderTemplate: "checkout_abandonment_reminder",
        reminderVariables: {
          customer_name: "Customer",
          cart_value: "7999.00",
          currency: "INR",
          checkout_url: `https://checkout.example.com/pay/${input.checkoutId}`,
        },
        incentiveApproved: true,
        incentiveDiscountMinor: input.proposedIncentiveDiscountMinor ?? 50_000,
        incentiveChannel: "WHATSAPP",
        incentiveTemplate: "checkout_incentive_reminder",
        incentiveVariables: {
          customer_name: "Customer",
          discount_amount: "500",
          currency: "INR",
          checkout_url: `https://checkout.example.com/pay/${input.checkoutId}?coupon=SAVE500`,
        },
        actions: [
          {
            type: "SEND_WHATSAPP",
            parameters: { template: "checkout_abandonment_reminder" },
          },
          {
            type: "OFFER_INCENTIVE",
            parameters: { discount_minor: 50000 },
          },
        ],
      };
    },

    async checkoutRaceGuard() {
      return {
        safeToSend: true,
        isCompleted: false,
        status: "STARTED",
      };
    },

    async checkInvoiceStatus() {
      return {
        exists: true,
        status: "OVERDUE",
        isPaid: false,
        isDisputed: false,
        amount: "5000000",
        amountPaid: "0",
        currency: "INR",
        customerId: "cust-1",
      };
    },

    async createPromiseToPay(input) {
      return {
        promiseId: randomUUID(),
        status: "MADE",
        promisedByDate: input.promisedByDate ?? "2026-09-20",
        caseId: input.caseId,
        // Deterministic test wait. Real activity computes waitDelay from
        // promised_by_date + 24h grace (audit s-24). No metadata override:
        // CreatePromiseToPayActivityInput carries no metadata field.
        waitDelay: "24h",
        waitDelayMs: 24 * 3600 * 1000,
        computedDefaultDate: !input.promisedByDate,
      };
    },

    async resolvePromiseToPay(input) {
      return {
        promiseId: input.promiseId,
        status: input.status,
        resolvedAt: new Date().toISOString(),
        honoredPaymentId: input.honoredPaymentId,
      };
    },
  };

  const mockActivities = {} as RecoveryActivities;
  for (const [key, fn] of Object.entries(defaultMocks) as [keyof RecoveryActivities, (args: unknown) => Promise<unknown>][]) {
    const overrideFn = customOverrides[key] as ((args: unknown) => Promise<unknown>) | undefined;
    const targetFn = overrideFn ?? fn;
    (mockActivities as Record<string, unknown>)[key] = async (args: unknown) => {
      recordCall(key, [args]);
      return await targetFn(args);
    };
  }

  return { mockActivities, spy };
}
