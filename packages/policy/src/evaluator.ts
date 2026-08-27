import { matchRuleDefinition } from "./matcher";
import { getCompiledRuleEvaluator } from "./rules";
import { createDefaultActiveRules } from "./seed-defaults";
import type {
  ActionProposal,
  ActivePolicyRule,
  EffectiveAction,
  NormalizedEvaluationContext,
  OverallPolicyResult,
  PolicyEvaluationResult,
  PolicyInput,
  PolicyRejection,
} from "./types";

/**
 * Normalizes user-supplied input into canonical camelCase / snake_case access structure.
 */
function normalizeContext(
  input: PolicyInput,
  action: ActionProposal,
  actionIndex: number,
): NormalizedEvaluationContext {
  const rawCase = input.case || ({} as any);
  const rawCust = input.customer || ({} as any);
  const rawDec = input.decision;
  const rawCounters = input.counters || ({} as any);

  const amountAtRisk = Number(
    rawCase.amount_at_risk ?? rawCase.amountAtRisk ?? 0,
  );
  const retryCount = Number(rawCase.retry_count ?? rawCase.retryCount ?? 0);

  let diagnosisConfidence = 1.0;
  let requiresApproval = false;

  if (rawDec) {
    const rawConf =
      rawDec.diagnosis_confidence ??
      rawDec.diagnosisConfidence ??
      rawDec.diagnosis?.confidence;
    if (rawConf !== undefined && rawConf !== null) {
      const parsed = Number(rawConf);
      if (!isNaN(parsed)) {
        diagnosisConfidence = parsed;
      }
    }

    requiresApproval = Boolean(
      rawDec.requires_approval ?? rawDec.requiresApproval,
    );
  }

  return {
    case: {
      ...rawCase,
      id: String(rawCase.id || ""),
      tenant_id: String(rawCase.tenant_id ?? rawCase.tenantId ?? ""),
      risk_type: String(rawCase.risk_type ?? rawCase.riskType ?? ""),
      amount_at_risk: amountAtRisk,
      currency: String(rawCase.currency ?? "INR"),
      retry_count: retryCount,
      status: String(rawCase.status ?? "IN_PROGRESS"),
      payment_status: String(rawCase.payment_status ?? rawCase.paymentStatus ?? ""),
    },
    customer: {
      ...rawCust,
      opted_out: Boolean(rawCust.opted_out ?? rawCust.optedOut),
      dispute_open: Boolean(rawCust.dispute_open ?? rawCust.disputeOpen),
    },
    decision: rawDec
      ? {
          ...rawDec,
          diagnosis_confidence: diagnosisConfidence,
          requires_approval: requiresApproval,
          diagnosis: rawDec.diagnosis
            ? {
                cause: rawDec.diagnosis.cause,
                confidence: typeof rawDec.diagnosis.confidence === "number" ? rawDec.diagnosis.confidence : Number(rawDec.diagnosis.confidence || 0),
                rationale: rawDec.diagnosis.rationale,
              }
            : undefined,
        }
      : null,
    counters: {
      ...rawCounters,
      whatsapp_sent_7d: Number(rawCounters.whatsapp_sent_7d ?? 0),
      email_sent_14d: Number(rawCounters.email_sent_14d ?? 0),
      sms_sent_7d: Number(rawCounters.sms_sent_7d ?? 0),
    },
    action: {
      type: String(action.type || ""),
      params: action.params ? { ...action.params } : {},
    },
    action_index: actionIndex,
    options: input.options || {},
  };
}

/**
 * Pure orchestration of policy rules against proposed actions.
 * Dependency-free, deterministic, and allocation-light (<50ms target).
 */
export function evaluate(
  input: PolicyInput,
  rules?: ActivePolicyRule[],
): PolicyEvaluationResult {
  const activeRules =
    rules && rules.length > 0
      ? rules.filter((r) => r.enabled !== false)
      : createDefaultActiveRules();

  const rejections: PolicyRejection[] = [];
  const effectiveActions: EffectiveAction[] = [];
  const appliedRuleCodes = new Set<string>();
  const ruleVersionIds = new Set<string>();

  if (input.policy_version_ids) {
    for (const id of input.policy_version_ids) {
      if (id) ruleVersionIds.add(id);
    }
  }

  const actions = input.actions ?? [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if (!action) continue;

    let context = normalizeContext(input, action, i);

    let isRejected = false;
    let actionRejection: PolicyRejection | null = null;
    let requiresApproval = false;
    let isAdjusted = false;
    let currentParams = { ...action.params };
    let adjustmentReason = "";

    for (const rule of activeRules) {
      if (rule.activeVersionId) {
        ruleVersionIds.add(rule.activeVersionId);
      }

      // Check compiled evaluator first for high performance
      const compiledEvaluator = getCompiledRuleEvaluator(rule.code);
      let outcome = compiledEvaluator ? compiledEvaluator(context, rule) : null;

      // If no compiled evaluator or outcome was null, evaluate declarative definition if conditions exist
      if (!outcome && rule.definition && rule.definition.conditions) {
        outcome = matchRuleDefinition(rule.definition, context, rule.code);
      }

      if (outcome && outcome.matched) {
        appliedRuleCodes.add(rule.code);

        if (outcome.verdict === "REJECT") {
          isRejected = true;
          actionRejection = {
            action_index: i,
            rule_code: rule.code,
            reason: outcome.reason || rule.code,
            action_type: action.type,
          };
          // Hard reject halts further rule evaluations for this action
          break;
        }

        if (outcome.verdict === "REQUIRE_APPROVAL") {
          requiresApproval = true;
          if (outcome.adjusted_params) {
            currentParams = { ...currentParams, ...outcome.adjusted_params };
            isAdjusted = true;
            adjustmentReason = outcome.adjustment_reason || "";
            // Update context with adjusted params for downstream rules
            context.action.params = currentParams;
          }
        } else if (outcome.verdict === "ADJUST") {
          isAdjusted = true;
          if (outcome.adjusted_params) {
            currentParams = { ...currentParams, ...outcome.adjusted_params };
            // Update context with adjusted params for downstream rules
            context.action.params = currentParams;
          }
          adjustmentReason = outcome.adjustment_reason || "";
        }
      }
    }

    if (isRejected && actionRejection) {
      rejections.push(actionRejection);
    } else if (requiresApproval) {
      effectiveActions.push({
        type: action.type,
        params: currentParams,
        status: "REQUIRE_APPROVAL",
        original_params: isAdjusted ? action.params : undefined,
        adjustment_reason: isAdjusted ? adjustmentReason : undefined,
      });
    } else if (isAdjusted) {
      effectiveActions.push({
        type: action.type,
        params: currentParams,
        status: "ADJUSTED",
        original_params: action.params,
        adjustment_reason: adjustmentReason,
      });
    } else {
      effectiveActions.push({
        type: action.type,
        params: currentParams,
        status: "ALLOWED",
      });
    }
  }

  // Determine overall verdict
  let overallResult: OverallPolicyResult;
  let allowed: boolean;
  let requiredApprovalFlag: boolean;

  if (actions.length === 0) {
    overallResult = "ALLOWED";
    allowed = true;
    requiredApprovalFlag = false;
  } else if (effectiveActions.length === 0) {
    overallResult = "REJECTED";
    allowed = false;
    requiredApprovalFlag = false;
  } else if (effectiveActions.some((a) => a.status === "REQUIRE_APPROVAL")) {
    overallResult = "REQUIRE_APPROVAL";
    allowed = false;
    requiredApprovalFlag = true;
  } else {
    overallResult = "ALLOWED";
    allowed = true;
    requiredApprovalFlag = false;
  }

  return {
    allowed,
    required_approval: requiredApprovalFlag,
    result: overallResult,
    rejections,
    effective_actions: effectiveActions,
    applied_rules: Array.from(appliedRuleCodes),
    rule_versions: Array.from(ruleVersionIds),
  };
}
