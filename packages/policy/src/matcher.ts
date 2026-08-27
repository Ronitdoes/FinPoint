import type {
  MatcherOperator,
  NormalizedEvaluationContext,
  RuleCondition,
  RuleDefinition,
  RuleEvaluationOutcome,
} from "./types";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Safely resolves a dot-delimited path on an object without prototype access.
 */
export function getFieldValue(obj: unknown, path: string): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return undefined;
  }

  const parts = path.split(".");
  let current: any = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    if (FORBIDDEN_KEYS.has(part)) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

/**
 * Coerces value to number if possible, preserving NaN on non-convertibles.
 */
function toNumber(val: unknown): number {
  if (typeof val === "number") return val;
  if (typeof val === "bigint") return Number(val);
  if (typeof val === "string") {
    const parsed = Number(val);
    return isNaN(parsed) ? NaN : parsed;
  }
  return NaN;
}

/**
 * Evaluates a single atomic condition against context.
 */
export function evaluateCondition(
  condition: RuleCondition,
  context: NormalizedEvaluationContext,
): boolean {
  const actual = getFieldValue(context, condition.field);
  const expected = condition.value;
  const op: MatcherOperator = condition.op;

  switch (op) {
    case "eq": {
      if (actual === expected) return true;
      // Handle boolean string equality
      if (typeof actual === "boolean" && typeof expected === "string") {
        return String(actual) === expected.toLowerCase();
      }
      // Handle numeric equality with coercion
      const numA = toNumber(actual);
      const numE = toNumber(expected);
      if (!isNaN(numA) && !isNaN(numE)) {
        return numA === numE;
      }
      return actual === expected;
    }

    case "neq": {
      return !evaluateCondition({ ...condition, op: "eq" }, context);
    }

    case "gt": {
      const numA = toNumber(actual);
      const numE = toNumber(expected);
      if (isNaN(numA) || isNaN(numE)) return false;
      return numA > numE;
    }

    case "gte": {
      const numA = toNumber(actual);
      const numE = toNumber(expected);
      if (isNaN(numA) || isNaN(numE)) return false;
      return numA >= numE;
    }

    case "lt": {
      const numA = toNumber(actual);
      const numE = toNumber(expected);
      if (isNaN(numA) || isNaN(numE)) return false;
      return numA < numE;
    }

    case "lte": {
      const numA = toNumber(actual);
      const numE = toNumber(expected);
      if (isNaN(numA) || isNaN(numE)) return false;
      return numA <= numE;
    }

    case "in": {
      if (!Array.isArray(expected)) return false;
      return expected.some((expItem) => {
        return evaluateCondition({ field: condition.field, op: "eq", value: expItem }, context);
      });
    }

    case "not_in": {
      if (!Array.isArray(expected)) return true;
      return !evaluateCondition({ ...condition, op: "in" }, context);
    }

    case "contains": {
      if (typeof actual === "string" && typeof expected === "string") {
        return actual.includes(expected);
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;
    }

    case "exists": {
      const shouldExist = expected === undefined || expected === true;
      const doesExist = actual !== undefined && actual !== null;
      return shouldExist ? doesExist : !doesExist;
    }

    default:
      return false;
  }
}

/**
 * Checks if a rule applies to a specific action type.
 */
export function ruleAppliesToAction(
  appliesTo: string[] | undefined,
  actionType: string,
): boolean {
  if (!appliesTo || appliesTo.length === 0) {
    return true; // applies to all actions if unspecified
  }
  if (appliesTo.includes("*") || appliesTo.includes("ALL")) {
    return true;
  }
  return appliesTo.includes(actionType);
}

/**
 * Interprets a declarative JSONB rule definition against the evaluation context.
 */
export function matchRuleDefinition(
  definition: RuleDefinition,
  context: NormalizedEvaluationContext,
  ruleCode: string,
): RuleEvaluationOutcome {
  const actionType = context.action.type;

  // 1. Check if rule applies to this action
  if (!ruleAppliesToAction(definition.applies_to, actionType)) {
    return { matched: false, rule_code: ruleCode };
  }

  // 2. Evaluate all conditions (AND logic)
  const conditions = definition.conditions ?? [];
  if (conditions.length > 0) {
    const allMatched = conditions.every((cond) => evaluateCondition(cond, context));
    if (!allMatched) {
      return { matched: false, rule_code: ruleCode };
    }
  }

  // 3. Rule matched - determine verdict and effects
  const rawEffect = (definition.effect || "REJECT").toUpperCase();
  const verdict =
    rawEffect === "REQUIRE_APPROVAL"
      ? "REQUIRE_APPROVAL"
      : rawEffect === "ALLOW"
        ? "ALLOW"
        : rawEffect === "ADJUST"
          ? "ADJUST"
          : "REJECT";

  const reason = definition.reason_code || definition.reason_message || ruleCode;

  // 4. Handle clamping if specified
  let adjustedParams: Record<string, unknown> | undefined;
  let adjustmentReason: string | undefined;

  if (definition.clamp && definition.clamp.field) {
    const currentVal = toNumber(getFieldValue(context, definition.clamp.field));
    if (!isNaN(currentVal)) {
      let clampedVal = currentVal;
      if (definition.clamp.max_value !== undefined && clampedVal > definition.clamp.max_value) {
        clampedVal = definition.clamp.max_value;
      }
      if (definition.clamp.min_value !== undefined && clampedVal < definition.clamp.min_value) {
        clampedVal = definition.clamp.min_value;
      }

      if (clampedVal !== currentVal) {
        // Clone and adjust params
        adjustedParams = { ...context.action.params };
        // Set clamped value in params (assumes param field name or path)
        const paramKey = definition.clamp.field.replace(/^action\.params\./, "").replace(/^params\./, "");
        adjustedParams[paramKey] = clampedVal;
        adjustmentReason = `Clamped ${paramKey} from ${currentVal} to ${clampedVal} per rule ${ruleCode}`;
      }
    }
  }

  return {
    matched: true,
    verdict,
    rule_code: ruleCode,
    reason,
    adjusted_params: adjustedParams,
    adjustment_reason: adjustmentReason,
  };
}
