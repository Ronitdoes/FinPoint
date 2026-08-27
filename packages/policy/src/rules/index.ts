import type { CompiledRuleEvaluator } from "../types";
import { evaluateOptoutRule } from "./optout";
import { evaluateDisputeRule } from "./dispute";
import { evaluateMaxRetryRule } from "./max-retry";
import { evaluateWhatsAppCapRule, evaluateEmailCapRule } from "./contact-caps";
import { evaluateDiscountCapRule } from "./discount-cap";
import { evaluateHighValueRule } from "./high-value";
import { evaluateConfidenceRule } from "./confidence";
import { evaluatePaymentSuccessRule } from "./payment-success";

export {
  evaluateOptoutRule,
  evaluateDisputeRule,
  evaluateMaxRetryRule,
  evaluateWhatsAppCapRule,
  evaluateEmailCapRule,
  evaluateDiscountCapRule,
  evaluateHighValueRule,
  evaluateConfidenceRule,
  evaluatePaymentSuccessRule,
};

/**
 * Map of standard compiled rule evaluators by rule code.
 */
export const COMPILED_RULE_REGISTRY: Record<string, CompiledRuleEvaluator> = {
  "POL-OPTOUT": evaluateOptoutRule,
  "POL-DISPUTE": evaluateDisputeRule,
  "POL-MAXRETRY": evaluateMaxRetryRule,
  "POL-WA-CAP": evaluateWhatsAppCapRule,
  "POL-EM-CAP": evaluateEmailCapRule,
  "POL-DISCOUNT": evaluateDiscountCapRule,
  "POL-HIGHVALUE": evaluateHighValueRule,
  "POL-CONFIDENCE": evaluateConfidenceRule,
  "POL-PAYMENT-SUCCESS": evaluatePaymentSuccessRule,
};

export function getCompiledRuleEvaluator(ruleCode: string): CompiledRuleEvaluator | undefined {
  return COMPILED_RULE_REGISTRY[ruleCode];
}
