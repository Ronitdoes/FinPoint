import type { CompiledRuleEvaluator } from "../types";

const CONTACT_ACTIONS = new Set(["SEND_EMAIL", "SEND_WHATSAPP", "SEND_SMS"]);

export const evaluateOptoutRule: CompiledRuleEvaluator = (context) => {
  const isOptedOut = Boolean(context.customer.opted_out);
  const actionType = context.action.type;

  if (isOptedOut && CONTACT_ACTIONS.has(actionType)) {
    return {
      matched: true,
      verdict: "REJECT",
      rule_code: "POL-OPTOUT",
      reason: "CUSTOMER_OPTED_OUT",
    };
  }

  return null;
};
