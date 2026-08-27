import { MAX_AUTO_DISCOUNT_MINOR } from "@repo/domain";
import type { CompiledRuleEvaluator } from "../types";

export const evaluateDiscountCapRule: CompiledRuleEvaluator = (context, rule) => {
  const actionType = context.action.type;
  if (actionType !== "OFFER_INCENTIVE") {
    return null;
  }

  const rawAmount =
    context.action.params.amount_minor ??
    context.action.params.amountMinor ??
    context.action.params.amount ??
    0;
  const amountMinor = Number(rawAmount);

  const maxDiscountCap =
    typeof rule?.definition?.max_amount_minor === "number"
      ? rule.definition.max_amount_minor
      : MAX_AUTO_DISCOUNT_MINOR;

  const clampEnabled =
    context.options.clamp_to_cap === true ||
    rule?.definition?.clamp_enabled === true ||
    rule?.definition?.clamp !== undefined;

  // 1. If amount exceeds discount cap
  if (amountMinor > maxDiscountCap) {
    if (clampEnabled) {
      // Clamping to cap: produces ADJUSTED
      const adjustedParams = {
        ...context.action.params,
        amount_minor: maxDiscountCap,
      };

      // Check if confidence gate or approval is also required after clamping
      const decisionNeedsApproval =
        context.decision?.requires_approval === true ||
        (context.decision?.diagnosis_confidence !== undefined &&
          context.decision.diagnosis_confidence < 0.6);

      return {
        matched: true,
        verdict: decisionNeedsApproval ? "REQUIRE_APPROVAL" : "ADJUST",
        rule_code: "POL-DISCOUNT",
        reason: decisionNeedsApproval
          ? "INCENTIVE_REQUIRES_APPROVAL"
          : "DISCOUNT_CLAMPED_TO_CAP",
        adjusted_params: adjustedParams,
        adjustment_reason: `Incentive amount ${amountMinor} clamped to maximum allowed ${maxDiscountCap}`,
      };
    }

    // Clamping not active -> hard REJECT
    return {
      matched: true,
      verdict: "REJECT",
      rule_code: "POL-DISCOUNT",
      reason: "MAX_DISCOUNT_EXCEEDED",
    };
  }

  // 2. Amount is within cap, check if confidence gate triggers approval requirement
  const confidence = context.decision?.diagnosis_confidence;
  const requiresApprovalFlag = context.decision?.requires_approval;

  if (requiresApprovalFlag === true || (confidence !== undefined && confidence < 0.6)) {
    return {
      matched: true,
      verdict: "REQUIRE_APPROVAL",
      rule_code: "POL-DISCOUNT",
      reason: "INCENTIVE_REQUIRES_APPROVAL",
    };
  }

  return null;
};
