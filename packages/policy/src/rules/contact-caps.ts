import {
  MAX_EMAIL_PER_14_DAYS,
  MAX_WHATSAPP_PER_7_DAYS,
} from "@repo/domain";
import type { CompiledRuleEvaluator } from "../types";

export const evaluateWhatsAppCapRule: CompiledRuleEvaluator = (context) => {
  const actionType = context.action.type;
  if (actionType !== "SEND_WHATSAPP") {
    return null;
  }

  const sentCount = Number(context.counters.whatsapp_sent_7d ?? 0);

  if (sentCount >= MAX_WHATSAPP_PER_7_DAYS) {
    return {
      matched: true,
      verdict: "REJECT",
      rule_code: "POL-WA-CAP",
      reason: "WHATSAPP_FREQUENCY_CAP_EXCEEDED",
    };
  }

  return null;
};

export const evaluateEmailCapRule: CompiledRuleEvaluator = (context) => {
  const actionType = context.action.type;
  if (actionType !== "SEND_EMAIL") {
    return null;
  }

  const sentCount = Number(context.counters.email_sent_14d ?? 0);

  if (sentCount >= MAX_EMAIL_PER_14_DAYS) {
    return {
      matched: true,
      verdict: "REJECT",
      rule_code: "POL-EM-CAP",
      reason: "EMAIL_FREQUENCY_CAP_EXCEEDED",
    };
  }

  return null;
};
