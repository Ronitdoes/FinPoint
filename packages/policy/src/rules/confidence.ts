import { HIGH_STAKES_CONFIDENCE_ACTIONS } from "@repo/domain";
import type { CompiledRuleEvaluator } from "../types";

// Single source of truth shared with the governance requiresApproval hook
// (apps/backend ai/governance/confidence.ts) via @repo/domain.
const HIGH_STAKES_ACTIONS = HIGH_STAKES_CONFIDENCE_ACTIONS;

export const evaluateConfidenceRule: CompiledRuleEvaluator = (context) => {
  const decision = context.decision;
  if (!decision) {
    return null;
  }

  const actionType = context.action.type;

  // 1. Explicit requires_approval flag on decision
  if (decision.requires_approval === true) {
    return {
      matched: true,
      verdict: "REQUIRE_APPROVAL",
      rule_code: "POL-CONFIDENCE",
      reason: "CONFIDENCE_GATE_TRIGGERED",
    };
  }

  // 2. High-stakes actions require approval if diagnosis confidence < 0.6
  if (HIGH_STAKES_ACTIONS.has(actionType)) {
    const rawConf = decision.diagnosis_confidence ?? decision.diagnosis?.confidence;
    if (rawConf !== undefined && rawConf !== null) {
      const confNum = Number(rawConf);
      if (!isNaN(confNum) && confNum < 0.6) {
        return {
          matched: true,
          verdict: "REQUIRE_APPROVAL",
          rule_code: "POL-CONFIDENCE",
          reason: "LOW_CONFIDENCE_REQUIRES_APPROVAL",
        };
      }
    }
  }

  return null;
};
