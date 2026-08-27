import type { RiskType } from "@repo/domain";

export interface DecisionLike {
  diagnosis?: {
    cause?: string;
    confidence?: number | string;
    rationale?: string;
  };
  diagnosisConfidence?: number | string;
  actions?: unknown[];
  recommendedActions?: unknown[];
}

const HIGH_STAKES_ACTIONS = new Set([
  "RETRY_PAYMENT",
  "CREATE_PAYMENT_LINK",
  "OFFER_INCENTIVE",
]);

/**
 * Confidence hook contract (Spec 01 §10, Step 15 §4, consumed by policy engine s-16).
 *
 * Implements the MVP confidence-threshold policy rule:
 * - true  if any action ∈ {RETRY_PAYMENT, CREATE_PAYMENT_LINK, OFFER_INCENTIVE} AND diagnosis.confidence < 0.6
 * - true  if OFFER_INCENTIVE regardless of confidence
 * - false otherwise
 */
export function requiresApproval(
  decision: DecisionLike | null | undefined,
  _surface?: RiskType | string,
): boolean {
  if (!decision) {
    return false;
  }

  const rawConfidence =
    decision.diagnosis?.confidence ?? decision.diagnosisConfidence ?? 0;
  const confidence = typeof rawConfidence === "string" ? parseFloat(rawConfidence) : Number(rawConfidence);
  const normalizedConfidence = Number.isFinite(confidence) ? confidence : 0;

  const rawActions = decision.actions ?? decision.recommendedActions ?? [];
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    return false;
  }

  for (const action of rawActions) {
    let actionType = "";
    if (typeof action === "string") {
      actionType = action.trim();
    } else if (action && typeof action === "object") {
      actionType = String(
        (action as any).type ??
          (action as any).action_type ??
          (action as any).actionType ??
          "",
      ).trim();
    }

    if (!actionType) continue;

    // Rule 1: OFFER_INCENTIVE always requires human approval
    if (actionType === "OFFER_INCENTIVE") {
      return true;
    }

    // Rule 2: High-stakes actions require approval if confidence < 0.6
    if (HIGH_STAKES_ACTIONS.has(actionType) && normalizedConfidence < 0.6) {
      return true;
    }
  }

  return false;
}
