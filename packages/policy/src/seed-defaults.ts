import {
  HIGH_VALUE_APPROVAL_MINOR,
  MAX_AUTO_DISCOUNT_MINOR,
  MAX_EMAIL_PER_14_DAYS,
  MAX_PAYMENT_RETRIES,
  MAX_WHATSAPP_PER_7_DAYS,
} from "@repo/domain";
import type { ActivePolicyRule } from "./types";

export interface DefaultPolicyRuleDefinition {
  code: string;
  name: string;
  description: string;
  ruleKind: "REJECT" | "REQUIRE_APPROVAL" | "LIMIT";
  definition: Record<string, unknown>;
  enabled: boolean;
}

/**
 * 9 Default Platform Rules (Spec 01 §11, Spec 02 §7, Spec 03 §6, Step 16 Requirements).
 * Seeded with tenant_id = NULL.
 */
export const DEFAULT_POLICY_RULES: readonly DefaultPolicyRuleDefinition[] = Object.freeze([
  {
    code: "POL-OPTOUT",
    name: "Customer Opt-out Contact Halt",
    description: "Reject all outbound contact actions (Email, WhatsApp, SMS) when customer is opted out",
    ruleKind: "REJECT",
    definition: {
      applies_to: ["SEND_EMAIL", "SEND_WHATSAPP", "SEND_SMS"],
      conditions: [{ field: "customer.opted_out", op: "eq", value: true }],
      effect: "REJECT",
      reason_code: "CUSTOMER_OPTED_OUT",
    },
    enabled: true,
  },
  {
    code: "POL-DISPUTE",
    name: "Open Dispute Automation Halt",
    description: "Reject all autonomous actions when customer has an open dispute",
    ruleKind: "REJECT",
    definition: {
      applies_to: ["*"],
      conditions: [{ field: "customer.dispute_open", op: "eq", value: true }],
      effect: "REJECT",
      reason_code: "DISPUTE_OPEN",
    },
    enabled: true,
  },
  {
    code: "POL-MAXRETRY",
    name: "Payment Retry Cap",
    description: `Reject payment retries when retry count is ${MAX_PAYMENT_RETRIES} or higher`,
    ruleKind: "REJECT",
    definition: {
      applies_to: ["RETRY_PAYMENT"],
      conditions: [{ field: "case.retry_count", op: "gte", value: MAX_PAYMENT_RETRIES }],
      effect: "REJECT",
      reason_code: "MAX_RETRIES_REACHED",
    },
    enabled: true,
  },
  {
    code: "POL-WA-CAP",
    name: "WhatsApp 7-Day Frequency Cap",
    description: `Cap WhatsApp messages to max ${MAX_WHATSAPP_PER_7_DAYS} in 7 days`,
    ruleKind: "REJECT",
    definition: {
      applies_to: ["SEND_WHATSAPP"],
      conditions: [{ field: "counters.whatsapp_sent_7d", op: "gte", value: MAX_WHATSAPP_PER_7_DAYS }],
      effect: "REJECT",
      reason_code: "WHATSAPP_FREQUENCY_CAP_EXCEEDED",
    },
    enabled: true,
  },
  {
    code: "POL-EM-CAP",
    name: "Email 14-Day Frequency Cap",
    description: `Cap email messages to max ${MAX_EMAIL_PER_14_DAYS} in 14 days`,
    ruleKind: "REJECT",
    definition: {
      applies_to: ["SEND_EMAIL"],
      conditions: [{ field: "counters.email_sent_14d", op: "gte", value: MAX_EMAIL_PER_14_DAYS }],
      effect: "REJECT",
      reason_code: "EMAIL_FREQUENCY_CAP_EXCEEDED",
    },
    enabled: true,
  },
  {
    code: "POL-DISCOUNT",
    name: "Incentive Discount Cap & Approval Gate",
    description: `Cap automated discount to ₹500 (${MAX_AUTO_DISCOUNT_MINOR} minor units) and require human approval for incentives`,
    ruleKind: "LIMIT",
    definition: {
      applies_to: ["OFFER_INCENTIVE"],
      max_amount_minor: MAX_AUTO_DISCOUNT_MINOR,
      clamp_enabled: true,
      require_approval: true,
      effect: "REJECT",
      reason_code: "MAX_DISCOUNT_EXCEEDED",
    },
    enabled: true,
  },
  {
    code: "POL-HIGHVALUE",
    name: "High Value Case Approval Gate",
    description: `Require human approval for financial actions on cases exceeding ₹100,000 (${HIGH_VALUE_APPROVAL_MINOR} minor units)`,
    ruleKind: "REQUIRE_APPROVAL",
    definition: {
      applies_to: ["OFFER_INCENTIVE", "CREATE_PAYMENT_LINK"],
      conditions: [{ field: "case.amount_at_risk", op: "gt", value: HIGH_VALUE_APPROVAL_MINOR }],
      effect: "REQUIRE_APPROVAL",
      reason_code: "HIGH_VALUE_THRESHOLD_EXCEEDED",
    },
    enabled: true,
  },
  {
    code: "POL-CONFIDENCE",
    name: "AI Diagnosis Confidence Threshold Gate",
    description: "Require human approval when AI diagnosis confidence is below 0.6 on high-stakes actions",
    ruleKind: "REQUIRE_APPROVAL",
    definition: {
      applies_to: ["RETRY_PAYMENT", "CREATE_PAYMENT_LINK", "OFFER_INCENTIVE"],
      conditions: [{ field: "decision.diagnosis_confidence", op: "lt", value: 0.6 }],
      effect: "REQUIRE_APPROVAL",
      reason_code: "LOW_CONFIDENCE_REQUIRES_APPROVAL",
    },
    enabled: true,
  },
  {
    code: "POL-PAYMENT-SUCCESS",
    name: "Payment Already Succeeded Stop Condition",
    description: "Reject all actions if the payment or case has already succeeded",
    ruleKind: "REJECT",
    definition: {
      applies_to: ["*"],
      conditions: [{ field: "case.payment_status", op: "eq", value: "SUCCEEDED" }],
      effect: "REJECT",
      reason_code: "PAYMENT_ALREADY_SUCCEEDED",
    },
    enabled: true,
  },
]);

/**
 * Creates default active policy rule models in-memory.
 */
export function createDefaultActiveRules(): ActivePolicyRule[] {
  return DEFAULT_POLICY_RULES.map((def, idx) => ({
    id: `default-rule-${def.code.toLowerCase()}`,
    tenantId: null,
    code: def.code,
    name: def.name,
    description: def.description,
    ruleKind: def.ruleKind,
    definition: def.definition as any,
    enabled: def.enabled,
    activeVersionId: `default-ver-${def.code.toLowerCase()}-v1`,
    activeVersionNumber: 1,
  }));
}
