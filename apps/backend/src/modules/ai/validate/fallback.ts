import type { RiskType, RiskBand } from "@repo/domain";
import type { DecisionRecord } from "../schemas/decision";

export interface FallbackContextInput {
  riskType: RiskType;
  riskBand?: RiskBand | string;
  priorRetriesCount?: number;
  overdueDays?: number;
  amountAtRiskMinor?: number;
  currency?: string;
}

/**
 * Generates a deterministic, rule-based recovery recommendation when LLM inference is
 * unavailable, times out, or fails validation (Spec 01 §10, Spec 03 §5, s-14 §Technical Implementation).
 * Guarantees that the recovery loop never stalls on LLM health.
 */
export function generateFallbackDecision(
  input: FallbackContextInput,
): DecisionRecord {
  const {
    riskType,
    riskBand = "MEDIUM",
    priorRetriesCount = 0,
    overdueDays = 0,
    amountAtRiskMinor = 10000,
    currency = "INR",
  } = input;

  switch (riskType) {
    case "PAYMENT_FAILURE": {
      if (priorRetriesCount >= 2) {
        return {
          diagnosis: {
            cause: "stale_card",
            confidence: 0.7,
            rationale:
              "Automated retry limit reached (>=2 attempts); escalating to human operator.",
          },
          actions: [
            {
              type: "CREATE_HUMAN_TASK",
              rationale: "Multiple automated payment retries failed.",
              params: {
                task_type: "manual_recovery",
                title: "Payment failure retry limit reached",
                description: "Customer has failed 2 or more automated retry attempts.",
                priority: "HIGH",
              },
            },
          ],
          stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT", "MAX_RETRIES"],
        };
      }

      if (riskBand === "HIGH" || riskBand === "CRITICAL") {
        return {
          diagnosis: {
            cause: "insufficient_funds",
            confidence: 0.85,
            rationale:
              "High-risk first failure; scheduling retry with WhatsApp reminder.",
          },
          actions: [
            {
              type: "RETRY_PAYMENT",
              delay_hours: 24,
              rationale: "Automated retry scheduled in 24 hours.",
              params: { attempt_number: priorRetriesCount + 1 },
            },
            {
              type: "SEND_WHATSAPP",
              rationale: "Payment retry reminder sent via WhatsApp.",
              params: { template: "payment_retry_notice", variables: {} },
            },
          ],
          stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT", "MAX_RETRIES"],
        };
      }

      return {
        diagnosis: {
          cause: "insufficient_funds",
          confidence: 0.8,
          rationale: "Deterministic automated payment retry strategy.",
        },
        actions: [
          {
            type: "RETRY_PAYMENT",
            delay_hours: 24,
            rationale: "Automated retry scheduled in 24 hours.",
            params: { attempt_number: priorRetriesCount + 1 },
          },
        ],
        stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT", "MAX_RETRIES"],
      };
    }

    case "CHECKOUT_ABANDONMENT": {
      return {
        diagnosis: {
          cause: "distraction",
          confidence: 0.8,
          rationale: "Standard cart re-engagement for abandoned checkout.",
        },
        actions: [
          {
            type: "SEND_EMAIL",
            rationale: "Automated cart reminder email.",
            params: { template: "cart_reminder", variables: {} },
          },
        ],
        stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT", "POLICY_STOP"],
      };
    }

    case "INVOICE_OVERDUE": {
      if (overdueDays >= 7 || riskBand === "HIGH" || riskBand === "CRITICAL") {
        return {
          diagnosis: {
            cause: "waiting_for_payday",
            confidence: 0.8,
            rationale:
              "Invoice overdue >= 7 days; sending reminder with direct payment link.",
          },
          actions: [
            {
              type: "SEND_EMAIL",
              rationale: "Overdue invoice reminder email.",
              params: { template: "invoice_reminder", variables: {} },
            },
            {
              type: "CREATE_PAYMENT_LINK",
              rationale: "Convenient direct payment link generated.",
              params: {
                amount_minor: amountAtRiskMinor,
                currency,
                expires_in_hours: 72,
              },
            },
          ],
          stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT", "PROMISE_CREATED"],
        };
      }

      return {
        diagnosis: {
          cause: "distraction",
          confidence: 0.75,
          rationale: "Gentle reminder for recently overdue invoice.",
        },
        actions: [
          {
            type: "SEND_EMAIL",
            rationale: "Overdue invoice reminder email.",
            params: { template: "invoice_reminder", variables: {} },
          },
        ],
        stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT", "PROMISE_CREATED"],
      };
    }

    default: {
      return {
        diagnosis: {
          cause: "unknown",
          confidence: 0.5,
          rationale: "Default safe fallback for unrecognized recovery surface.",
        },
        actions: [
          {
            type: "CREATE_HUMAN_TASK",
            rationale: "Escalating unknown surface case for manual review.",
            params: {
              task_type: "manual_recovery",
              title: "Unrecognized recovery case",
              description: "Automated fallback requires human review.",
              priority: "MEDIUM",
            },
          },
        ],
        stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT", "POLICY_STOP"],
      };
    }
  }
}
