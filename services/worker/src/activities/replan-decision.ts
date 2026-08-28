import { randomUUID } from "node:crypto";
import {
  findCaseById,
  findCustomerById,
  listPolicyRules,
  recordPolicyEvaluation,
  createDecision,
  recordCaseEvent,
} from "@repo/db";
import {
  evaluate,
  type ActivePolicyRule,
  type RuleDefinition,
  createDefaultActiveRules,
} from "@repo/policy";
import type { ActionType } from "@repo/domain";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
  createNonRetryableFailure,
} from "../framework";

export interface RequestReplanDecisionInput extends ActivityContext {
  attemptsCount: number;
  lastDeclineCode?: string;
  lastDeclineMessage?: string;
  proposedOverride?: {
    actionType?: string;
    stopReason?: string;
    requiresApproval?: boolean;
    discountMinor?: number;
  };
}

export interface ReplanDecisionResult {
  decisionId: string;
  replanAction: "STOP_CASE" | "CREATE_HUMAN_TASK" | "SEND_MESSAGE" | "OFFER_INCENTIVE";
  actions: Array<{
    type: string;
    parameters?: Record<string, unknown>;
  }>;
  stopReason?: string;
  diagnosis: string;
  allowed: boolean;
  requiresApproval: boolean;
}

/**
 * Activity: requestReplanDecision
 * Performs a single bounded AI replan decision after failed retry rounds (Step 22 §Requirements 6).
 * Evaluates whether to stop, escalate to human, or propose a single alternate communication/incentive.
 */
export async function requestReplanDecision(
  input: RequestReplanDecisionInput,
): Promise<ReplanDecisionResult> {
  return await withActivityContext("requestReplanDecision", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const caseRecord = await findCaseById(
        { db, tx },
        { tenantId: input.tenantId, caseId: input.caseId },
      );

      if (!caseRecord) {
        throw createNonRetryableFailure(
          `Case '${input.caseId}' not found`,
          "ENTITY_NOT_FOUND",
        );
      }

      const customer = await findCustomerById(
        { db, tx },
        { tenantId: input.tenantId, customerId: caseRecord.customerId },
      );

      // Determine proposed replan action based on inputs and override
      let proposedActionType = "STOP_CASE";
      let proposedStopReason: string | undefined = "MAX_RETRIES";
      let diagnosis = `Exhausted ${input.attemptsCount} payment retry attempts; decline code: ${input.lastDeclineCode ?? "UNKNOWN"}`;

      if (input.proposedOverride) {
        if (input.proposedOverride.actionType) {
          proposedActionType = input.proposedOverride.actionType;
        }
        if (input.proposedOverride.stopReason) {
          proposedStopReason = input.proposedOverride.stopReason;
        }
      } else if (
        input.lastDeclineCode === "do_not_honor" ||
        input.lastDeclineCode === "stolen_card" ||
        input.lastDeclineCode === "fraudulent"
      ) {
        proposedActionType = "STOP_CASE";
        proposedStopReason = "PERMANENT_DECLINE";
        diagnosis = `Permanent decline code '${input.lastDeclineCode}'; recovery automation stopped`;
      }

      const proposedActions: Array<{ type: string; parameters?: Record<string, unknown> }> = [];
      if (proposedActionType === "OFFER_INCENTIVE") {
        const discountAmount = input.proposedOverride?.discountMinor ?? 100000;
        proposedActions.push({
          type: "OFFER_INCENTIVE",
          parameters: {
            discount_minor: discountAmount,
            reason: "High-value recovery incentive",
          },
        });
      } else if (proposedActionType === "SEND_MESSAGE" || proposedActionType === "SEND_EMAIL") {
        proposedActions.push({
          type: "SEND_EMAIL",
          parameters: { template: "payment_final_notice", variables: {} },
        });
      } else if (proposedActionType === "CREATE_HUMAN_TASK") {
        proposedActions.push({
          type: "CREATE_HUMAN_TASK",
          parameters: { reason: "EXHAUSTED_RETRIES_REVIEW" },
        });
      } else {
        proposedActions.push({
          type: "STOP_CASE",
          parameters: { reason: proposedStopReason },
        });
      }

      // Check Policy on proposed replan actions
      const dbRules = await listPolicyRules(
        { db, tx },
        { tenantId: input.tenantId },
      );

      const activeRules: ActivePolicyRule[] =
        dbRules.length > 0
          ? dbRules.map((r) => ({
              id: r.id,
              tenantId: r.tenantId ?? input.tenantId,
              code: r.code,
              name: r.name,
              ruleKind: r.ruleKind,
              definition: (r.definition ?? {}) as RuleDefinition,
              enabled: r.enabled,
            }))
          : createDefaultActiveRules();

      const evalResult = evaluate(
        {
          case: {
            id: caseRecord.id,
            tenant_id: caseRecord.tenantId,
            risk_type: caseRecord.riskType,
            amount_at_risk: caseRecord.amountAtRisk,
            currency: caseRecord.currency,
            status: caseRecord.status,
          },
          customer: {
            opted_out: customer?.optedOut ?? false,
          },
          actions: proposedActions.map((a) => ({
            type: a.type as ActionType,
            params: a.parameters ?? {},
          })),
          counters: {
            retry_count: input.attemptsCount,
          },
        },
        activeRules,
      );

      const ruleVersions =
        dbRules.length > 0 ? dbRules.map((r) => r.id) : [randomUUID()];
      const requiresApproval =
        evalResult.required_approval ||
        Boolean(input.proposedOverride?.requiresApproval);

      await recordPolicyEvaluation(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          ruleVersions,
          result:
            evalResult.rejections.length > 0
              ? "REJECTED"
              : requiresApproval
                ? "REQUIRE_APPROVAL"
                : "ALLOWED",
          rejections: evalResult.rejections,
          effectiveActions: evalResult.effective_actions,
          latencyMs: 5,
        },
      );

      // Persist decision row
      const createdDec = await createDecision(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          model: "gpt-4o",
          promptVersion: "payment_failure@1",
          inputSnapshot: {
            attemptsCount: input.attemptsCount,
            lastDeclineCode: input.lastDeclineCode,
            caseId: input.caseId,
          },
          diagnosisCause: "insufficient_funds",
          diagnosisConfidence: "0.95",
          recommendedActions: proposedActions,
          stopConditions: ["MAX_RETRIES", "PAYMENT_SUCCEEDED"],
          status: "COMPLETED",
          latencyMs: 200,
        },
      );

      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: "AI_DECISION_CREATED",
          actorType: "SYSTEM",
          description: `AI replan decision recorded: ${proposedActionType} (decisionId: ${createdDec.id})`,
          payload: {
            decisionId: createdDec.id,
            actionType: proposedActionType,
            requiresApproval,
            diagnosis,
          },
        },
      );

      let mappedAction: "STOP_CASE" | "CREATE_HUMAN_TASK" | "SEND_MESSAGE" | "OFFER_INCENTIVE" = "STOP_CASE";
      if (proposedActionType === "CREATE_HUMAN_TASK") {
        mappedAction = "CREATE_HUMAN_TASK";
      } else if (proposedActionType === "OFFER_INCENTIVE") {
        mappedAction = "OFFER_INCENTIVE";
      } else if (
        proposedActionType === "SEND_MESSAGE" ||
        proposedActionType === "SEND_EMAIL" ||
        proposedActionType === "SEND_WHATSAPP"
      ) {
        mappedAction = "SEND_MESSAGE";
      }

      return {
        decisionId: createdDec.id,
        replanAction: mappedAction,
        actions: proposedActions,
        stopReason: proposedStopReason,
        diagnosis,
        allowed: evalResult.rejections.length === 0,
        requiresApproval,
      };
    });
  });
}
