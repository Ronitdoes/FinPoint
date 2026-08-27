import type { CompiledRuleEvaluator } from "../types";

export const evaluateDisputeRule: CompiledRuleEvaluator = (context) => {
  const isDisputeOpen = Boolean(context.customer.dispute_open);

  if (isDisputeOpen) {
    return {
      matched: true,
      verdict: "REJECT",
      rule_code: "POL-DISPUTE",
      reason: "DISPUTE_OPEN",
    };
  }

  return null;
};
