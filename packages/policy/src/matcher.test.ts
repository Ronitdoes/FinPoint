import { describe, expect, it } from "vitest";
import { evaluateCondition, getFieldValue, matchRuleDefinition } from "./matcher";
import type { NormalizedEvaluationContext, RuleDefinition } from "./types";

function createMockContext(overrides: Partial<NormalizedEvaluationContext> = {}): NormalizedEvaluationContext {
  return {
    case: {
      id: "case-123",
      tenant_id: "tenant-abc",
      risk_type: "PAYMENT_FAILURE",
      amount_at_risk: 150_000,
      currency: "INR",
      retry_count: 2,
      status: "IN_PROGRESS",
      payment_status: "FAILED",
      ...overrides.case,
    },
    customer: {
      opted_out: false,
      dispute_open: false,
      tier: "ENTERPRISE",
      ...overrides.customer,
    },
    decision: {
      diagnosis_confidence: 0.88,
      requires_approval: false,
      ...overrides.decision,
    },
    counters: {
      whatsapp_sent_7d: 1,
      email_sent_14d: 2,
      sms_sent_7d: 0,
      ...overrides.counters,
    },
    action: {
      type: "SEND_WHATSAPP",
      params: { template: "reminder_v1", amount_minor: 50_000 },
      ...overrides.action,
    },
    action_index: overrides.action_index ?? 0,
    options: overrides.options || {},
  };
}

describe("Matcher Security & Condition Evaluation", () => {
  describe("getFieldValue (Safe Path Traversal)", () => {
    it("safely extracts nested object values", () => {
      const ctx = createMockContext();
      expect(getFieldValue(ctx, "case.amount_at_risk")).toBe(150_000);
      expect(getFieldValue(ctx, "customer.tier")).toBe("ENTERPRISE");
      expect(getFieldValue(ctx, "action.params.template")).toBe("reminder_v1");
    });

    it("returns undefined for non-existent paths", () => {
      const ctx = createMockContext();
      expect(getFieldValue(ctx, "case.non_existent_field")).toBeUndefined();
      expect(getFieldValue(ctx, "non.existent.path")).toBeUndefined();
    });

    it("blocks prototype pollution / prototype traversal attempts", () => {
      const ctx = createMockContext();
      expect(getFieldValue(ctx, "__proto__")).toBeUndefined();
      expect(getFieldValue(ctx, "constructor.prototype")).toBeUndefined();
      expect(getFieldValue(ctx, "case.__proto__.polluted")).toBeUndefined();
    });
  });

  describe("evaluateCondition (Operator Matching)", () => {
    const ctx = createMockContext();

    it("evaluates eq and neq", () => {
      expect(evaluateCondition({ field: "customer.opted_out", op: "eq", value: false }, ctx)).toBe(true);
      expect(evaluateCondition({ field: "customer.opted_out", op: "eq", value: true }, ctx)).toBe(false);
      expect(evaluateCondition({ field: "customer.opted_out", op: "neq", value: true }, ctx)).toBe(true);
    });

    it("evaluates comparison operators (gt, gte, lt, lte)", () => {
      expect(evaluateCondition({ field: "case.retry_count", op: "gt", value: 1 }, ctx)).toBe(true);
      expect(evaluateCondition({ field: "case.retry_count", op: "gte", value: 2 }, ctx)).toBe(true);
      expect(evaluateCondition({ field: "case.retry_count", op: "lt", value: 5 }, ctx)).toBe(true);
      expect(evaluateCondition({ field: "case.retry_count", op: "lte", value: 2 }, ctx)).toBe(true);
      expect(evaluateCondition({ field: "case.retry_count", op: "gt", value: 3 }, ctx)).toBe(false);
    });

    it("evaluates in and not_in", () => {
      expect(evaluateCondition({ field: "action.type", op: "in", value: ["SEND_EMAIL", "SEND_WHATSAPP"] }, ctx)).toBe(true);
      expect(evaluateCondition({ field: "action.type", op: "in", value: ["RETRY_PAYMENT"] }, ctx)).toBe(false);
      expect(evaluateCondition({ field: "action.type", op: "not_in", value: ["RETRY_PAYMENT"] }, ctx)).toBe(true);
    });

    it("evaluates contains and exists", () => {
      expect(evaluateCondition({ field: "customer.tier", op: "contains", value: "ENTER" }, ctx)).toBe(true);
      expect(evaluateCondition({ field: "customer.tier", op: "exists" }, ctx)).toBe(true);
      expect(evaluateCondition({ field: "customer.missing_prop", op: "exists" }, ctx)).toBe(false);
    });
  });

  describe("matchRuleDefinition (Full Declarative Rule Matching)", () => {
    it("matches custom tenant rule and returns verdict", () => {
      const ctx = createMockContext({
        customer: { tier: "VIP", opted_out: false, dispute_open: false },
        action: { type: "OFFER_INCENTIVE", params: { amount_minor: 200_000 } },
      });

      const ruleDef: RuleDefinition = {
        applies_to: ["OFFER_INCENTIVE"],
        conditions: [
          { field: "customer.tier", op: "eq", value: "VIP" },
          { field: "action.params.amount_minor", op: "gt", value: 100_000 },
        ],
        effect: "REQUIRE_APPROVAL",
        reason_code: "VIP_HIGH_DISCOUNT_APPROVAL",
      };

      const outcome = matchRuleDefinition(ruleDef, ctx, "CUST-VIP-01");
      expect(outcome.matched).toBe(true);
      expect(outcome.verdict).toBe("REQUIRE_APPROVAL");
      expect(outcome.reason).toBe("VIP_HIGH_DISCOUNT_APPROVAL");
    });

    it("skips evaluation if rule does not apply to action type", () => {
      const ctx = createMockContext({
        action: { type: "SEND_EMAIL", params: {} },
      });

      const ruleDef: RuleDefinition = {
        applies_to: ["RETRY_PAYMENT"],
        conditions: [{ field: "case.retry_count", op: "gt", value: 0 }],
        effect: "REJECT",
      };

      const outcome = matchRuleDefinition(ruleDef, ctx, "CUST-RETRY-01");
      expect(outcome.matched).toBe(false);
    });

    it("maps LIMIT with clamp to ADJUST when the value exceeds the cap", () => {
      const ctx = createMockContext({
        action: { type: "OFFER_INCENTIVE", params: { amount_minor: 200_000 } },
      });

      const ruleDef: RuleDefinition = {
        applies_to: ["OFFER_INCENTIVE"],
        effect: "LIMIT",
        reason_code: "DISCOUNT_CAPPED",
        clamp: { field: "action.params.amount_minor", max_value: 50_000 },
      };

      const outcome = matchRuleDefinition(ruleDef, ctx, "CUST-LIMIT-01");
      expect(outcome.matched).toBe(true);
      expect(outcome.verdict).toBe("ADJUST");
      expect(outcome.adjusted_params).toMatchObject({ amount_minor: 50_000 });
    });

    it("treats LIMIT within cap as a no-op (no mutation)", () => {
      const ctx = createMockContext({
        action: { type: "OFFER_INCENTIVE", params: { amount_minor: 10_000 } },
      });

      const ruleDef: RuleDefinition = {
        applies_to: ["OFFER_INCENTIVE"],
        effect: "LIMIT",
        reason_code: "DISCOUNT_CAPPED",
        clamp: { field: "action.params.amount_minor", max_value: 50_000 },
      };

      const outcome = matchRuleDefinition(ruleDef, ctx, "CUST-LIMIT-02");
      expect(outcome.matched).toBe(false);
    });

    it("fails closed with an explicit reason for LIMIT without a clamp target", () => {
      const ctx = createMockContext({
        action: { type: "OFFER_INCENTIVE", params: { amount_minor: 200_000 } },
      });

      const ruleDef: RuleDefinition = {
        applies_to: ["OFFER_INCENTIVE"],
        effect: "LIMIT",
      };

      const outcome = matchRuleDefinition(ruleDef, ctx, "CUST-LIMIT-03");
      expect(outcome.matched).toBe(true);
      expect(outcome.verdict).toBe("REJECT");
      expect(outcome.reason).toBe("LIMIT_WITHOUT_CLAMP_TARGET");
    });
  });
});
