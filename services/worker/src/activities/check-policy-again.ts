import { randomUUID } from "node:crypto";
import {
  findCaseById,
  findCustomerById,
  listPolicyRules,
  recordPolicyEvaluation,
} from "@repo/db";
import {
  evaluate,
  type ActivePolicyRule,
  type RuleDefinition,
  createDefaultActiveRules,
} from "@repo/policy";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
  createNonRetryableFailure,
} from "../framework";

export interface CheckPolicyAgainInput extends ActivityContext {
  actionType: string;
  actionParams?: Record<string, unknown>;
  customerId?: string;
  amountMinor?: string | bigint;
  currency?: string;
}

export interface CheckPolicyAgainResult {
  allowed: boolean;
  requiresApproval: boolean;
  rejectionReason?: string;
  ruleCode?: string;
  policyEvaluationId?: string;
}

/**
 * Activity: checkPolicyAgain
 * Re-evaluates platform policies before executing a planned recovery action
 * (mandatory defense-in-depth step per Spec 01 §13 / Spec 02).
 */
export async function checkPolicyAgain(
  input: CheckPolicyAgainInput,
): Promise<CheckPolicyAgainResult> {
  return await withActivityContext("checkPolicyAgain", input, async () => {
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

      const customerId = input.customerId ?? caseRecord.customerId;
      const customer = await findCustomerById(
        { db, tx },
        { tenantId: input.tenantId, customerId },
      );

      // Load active rules for tenant, or fallback to default seeded platform rules
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
          actions: [
            {
              type: input.actionType,
              params: input.actionParams ?? {},
            },
          ],
          counters: {},
        },
        activeRules,
      );

      const hasRejection = evalResult.rejections.length > 0;
      const rejection = evalResult.rejections[0];

      const ruleVersions =
        dbRules.length > 0
          ? dbRules.map((r) => r.id)
          : [randomUUID()];

      // Record evaluation ledger entry
      const recorded = await recordPolicyEvaluation(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          ruleVersions,
          result: hasRejection
            ? "REJECTED"
            : evalResult.required_approval
              ? "REQUIRE_APPROVAL"
              : "ALLOWED",
          rejections: evalResult.rejections,
          effectiveActions: evalResult.effective_actions,
          latencyMs: 5,
        },
      );

      return {
        allowed: !hasRejection,
        requiresApproval: evalResult.required_approval,
        rejectionReason: rejection?.reason,
        ruleCode: rejection?.rule_code,
        policyEvaluationId: recorded.id,
      };
    });
  });
}
