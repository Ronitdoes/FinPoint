import type { CompiledRuleEvaluator } from "../types";

const HIGH_STAKES_ACTIONS = new Set([
  "RETRY_PAYMENT",
  "CREATE_PAYMENT_LINK",
  "OFFER_INCENTIVE",
]);

export const evaluateConfidenceRule: CompiledRuleEvaluator = (context) => {
  const decision = context.decision;
  if (!decision) {
    return null;
  }

  const actionType = context.action.type;

  // 1. Explicit requires_approval flag on decision
  if (decision.requires_approval === true) {
    return {
      matched: true,
      verdict: "REQUIRE_APPROVAL",
      rule_code: "POL-CONFIDENCE",
      reason: "CONFIDENCE_GATE_TRIGGERED",
    };
  }

  // 2. High-stakes actions require approval if diagnosis confidence < 0.6
  if (HIGH_STAKES_ACTIONS.has(actionType)) {
    const rawConf = decision.diagnosis_confidence ?? decision.diagnosis?.confidence;
    if (rawConf !== undefined && rawConf !== null) {
      const confNum = Number(rawConf);
      if (!isNaN(confNum) && confNum < 0.6) {
        return {
          matched: true,
          verdict: "REQUIRE_APPROVAL",
          rule_code: "POL-CONFIDENCE",
          reason: "LOW_CONFIDENCE_REQUIRES_APPROVAL",
        };
      }
    }
  }

  return null;
};
