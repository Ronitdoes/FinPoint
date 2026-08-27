import { MAX_PAYMENT_RETRIES } from "@repo/domain";
import type { CompiledRuleEvaluator } from "../types";

export const evaluateMaxRetryRule: CompiledRuleEvaluator = (context) => {
  const actionType = context.action.type;
  if (actionType !== "RETRY_PAYMENT") {
    return null;
  }

  const retryCount = Number(context.case.retry_count ?? 0);

  if (retryCount >= MAX_PAYMENT_RETRIES) {
    return {
      matched: true,
      verdict: "REJECT",
      rule_code: "POL-MAXRETRY",
      reason: "MAX_RETRIES_REACHED",
    };
  }

  return null;
};
