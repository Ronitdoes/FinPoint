import type { CompiledRuleEvaluator } from "../types";

const SUCCEEDED_STATUSES = new Set([
  "SUCCEEDED",
  "RECOVERED",
  "RESOLVED_UPSTREAM",
]);

export const evaluatePaymentSuccessRule: CompiledRuleEvaluator = (context) => {
  const paymentStatus = (context.case.payment_status || "").toUpperCase();
  const caseStatus = (context.case.status || "").toUpperCase();

  if (
    SUCCEEDED_STATUSES.has(paymentStatus) ||
    SUCCEEDED_STATUSES.has(caseStatus)
  ) {
    return {
      matched: true,
      verdict: "REJECT",
      rule_code: "POL-PAYMENT-SUCCESS",
      reason: "PAYMENT_ALREADY_SUCCEEDED",
    };
  }

  return null;
};
