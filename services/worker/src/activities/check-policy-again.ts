import { randomUUID } from "node:crypto";
import {
  findCaseById,
  findCustomerById,
  findPaymentById,
  findPaymentAttemptsByPaymentId,
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
  counters?: Record<string, number>;
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

      // s-22/s-24 audit: thread live retry_count + payment_status into the
      // evaluation context (previously never fed, leaving POL-MAXRETRY dead
      // and POL-PAYMENT-SUCCESS half-dead per-round). Mirrors the backend
      // policy.service.ts §3b derivation. Precedence:
      //   1. explicit input.counters.retry_count wins (the workflow's
      //      per-round view, e.g. failed-payment passes round-1);
      //   2. else live DB derivation for PAYMENT-linked cases
      //      (retry_count = COUNT(payment_attempts),
      //       payment_status = payments.status for the payment referenced by
      //       sourceEntityId);
      //   3. else legacy actionParams.attempt derivation (attempt-1), else 0.
      // Non-payment cases default to 0/"" — the case status alone still drives
      // POL-PAYMENT-SUCCESS via RECOVERED/RESOLVED_UPSTREAM.
      let retryCount: number | undefined;
      const explicitRetry =
        input.counters?.retry_count ?? input.counters?.retryCount;
      if (typeof explicitRetry === "number" && Number.isFinite(explicitRetry)) {
        retryCount = Math.max(0, Math.floor(explicitRetry));
      }

      let paymentStatus = "";
      if (
        caseRecord.sourceEntityType === "PAYMENT" &&
        caseRecord.sourceEntityId
      ) {
        const linkedPayment = await findPaymentById(
          { db, tx },
          { tenantId: input.tenantId, paymentId: caseRecord.sourceEntityId },
        );
        if (linkedPayment) {
          paymentStatus = linkedPayment.status ?? "";
          if (retryCount === undefined) {
            const attempts = await findPaymentAttemptsByPaymentId(
              { db, tx },
              { tenantId: input.tenantId, paymentId: linkedPayment.id },
            );
            retryCount = attempts.length;
          }
        }
      }

      if (retryCount === undefined) {
        const attemptRaw =
          input.actionParams?.attempt ??
          input.actionParams?.attemptNumber ??
          input.actionParams?.retry_count;
        const attemptNum = Number(attemptRaw);
        retryCount =
          Number.isFinite(attemptNum) && attemptNum > 0
            ? Math.max(0, Math.floor(attemptNum) - 1)
            : 0;
      }

      const evalResult = evaluate(
        {
          case: {
            id: caseRecord.id,
            tenant_id: caseRecord.tenantId,
            risk_type: caseRecord.riskType,
            amount_at_risk: caseRecord.amountAtRisk,
            currency: caseRecord.currency,
            status: caseRecord.status,
            retry_count: retryCount,
            payment_status: paymentStatus,
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
          counters:
            input.counters ??
            (input.actionParams?.counters as Record<string, number> | undefined) ??
            {},
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
