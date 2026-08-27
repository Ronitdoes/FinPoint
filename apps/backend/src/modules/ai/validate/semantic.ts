import {
  AI_DECIDABLE_ACTIONS,
  MAX_AUTO_DISCOUNT_MINOR,
  type RiskType,
} from "@repo/domain";
import type { DecisionRecord } from "../schemas/decision";

export interface SemanticValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates domain and business logic constraints on structurally valid decision records.
 * (Spec 01 §10, Spec 02 §2, Spec 03 §5)
 */
export function validateSemantic(
  decision: DecisionRecord,
  riskType: RiskType,
): SemanticValidationResult {
  const errors: string[] = [];
  const allowedActions = AI_DECIDABLE_ACTIONS[riskType] || [];

  // 1. Validate actions count
  if (decision.actions.length === 0) {
    errors.push("Decision must recommend at least one action");
  }
  if (decision.actions.length > 3) {
    errors.push(
      `Decision cannot exceed 3 actions (found: ${decision.actions.length})`,
    );
  }

  // 2. Validate STOP_CASE exclusivity
  const hasStopCase = decision.actions.some((a) => a.type === "STOP_CASE");
  if (hasStopCase && decision.actions.length > 1) {
    errors.push("STOP_CASE must be the sole recommended action");
  }

  // 3. Validate each action against surface allowlist and parameters
  for (let i = 0; i < decision.actions.length; i++) {
    const action = decision.actions[i];
    if (!action) continue;
    const prefix = `actions[${i}] (${action.type})`;

    if (!allowedActions.includes(action.type)) {
      errors.push(
        `${prefix} is not in the allowed action catalog for surface '${riskType}'. Allowed: [${allowedActions.join(", ")}]`,
      );
    }

    if (action.type === "RETRY_PAYMENT" && action.delay_hours !== undefined) {
      if (
        !Number.isInteger(action.delay_hours) ||
        action.delay_hours < 1 ||
        action.delay_hours > 168
      ) {
        errors.push(
          `${prefix}: delay_hours must be an integer between 1 and 168 hours (found: ${action.delay_hours})`,
        );
      }
    }

    if (action.type === "OFFER_INCENTIVE" && action.params) {
      const amountMinor = action.params.amount_minor;
      if (typeof amountMinor === "number") {
        if (amountMinor <= 0) {
          errors.push(`${prefix}: amount_minor must be positive`);
        } else if (amountMinor > MAX_AUTO_DISCOUNT_MINOR) {
          errors.push(
            `${prefix}: amount_minor (${amountMinor}) exceeds maximum policy cap (${MAX_AUTO_DISCOUNT_MINOR})`,
          );
        }
      }
    }
  }

  // 4. Validate diagnosis confidence
  if (
    typeof decision.diagnosis.confidence !== "number" ||
    decision.diagnosis.confidence < 0 ||
    decision.diagnosis.confidence > 1 ||
    Number.isNaN(decision.diagnosis.confidence)
  ) {
    errors.push("diagnosis.confidence must be a number between 0.0 and 1.0");
  }

  // 5. Validate stop conditions
  if (
    !decision.stop_conditions ||
    !Array.isArray(decision.stop_conditions) ||
    decision.stop_conditions.length === 0
  ) {
    errors.push("stop_conditions must contain at least one condition");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
