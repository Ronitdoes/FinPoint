import { HIGH_VALUE_APPROVAL_MINOR } from "@repo/domain";
import type { CompiledRuleEvaluator } from "../types";

const HIGH_VALUE_ACTIONS = new Set(["OFFER_INCENTIVE", "CREATE_PAYMENT_LINK"]);

export const evaluateHighValueRule: CompiledRuleEvaluator = (context) => {
  const actionType = context.action.type;
  if (!HIGH_VALUE_ACTIONS.has(actionType)) {
    return null;
  }

  const amountAtRisk = Number(context.case.amount_at_risk ?? 0);

  if (amountAtRisk > HIGH_VALUE_APPROVAL_MINOR) {
    return {
      matched: true,
      verdict: "REQUIRE_APPROVAL",
      rule_code: "POL-HIGHVALUE",
      reason: "HIGH_VALUE_THRESHOLD_EXCEEDED",
    };
  }

  return null;
};
