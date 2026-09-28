import { describe, it, expect } from "vitest";
import { validateStructural } from "./structural";
import { validateSemantic } from "./semantic";
import { generateFallbackDecision } from "./fallback";
import type { DecisionRecord } from "../schemas/decision";

describe("Validation Pipeline: Structural, Semantic & Fallback Recommender (Step 14)", () => {
  describe("Structural Validation", () => {
    it("accepts valid JSON decision object and returns structured data", () => {
      const validPayload = {
        diagnosis: {
          cause: "insufficient_funds",
          confidence: 0.85,
          rationale: "Card decline code indicates insufficient balance.",
        },
        actions: [
          {
            type: "RETRY_PAYMENT",
            delay_hours: 24,
            rationale: "Retry in 24 hours.",
          },
        ],
        stop_conditions: ["PAYMENT_SUCCEEDED", "MAX_RETRIES"],
      };

      const result = validateStructural(validPayload);
      expect(result.valid).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.errors).toHaveLength(0);
    });

    it("rejects non-object or malformed JSON payloads", () => {
      expect(validateStructural(null).valid).toBe(false);
      expect(validateStructural("invalid string").valid).toBe(false);
      expect(validateStructural({ diagnosis: "incomplete" }).valid).toBe(false);
    });
  });

  describe("Semantic Validation", () => {
    const baseDecision: DecisionRecord = {
      diagnosis: {
        cause: "insufficient_funds",
        confidence: 0.85,
        rationale: "Valid rationale",
      },
      actions: [
        {
          type: "RETRY_PAYMENT",
          delay_hours: 24,
          rationale: "Retry in 24h",
        },
      ],
      stop_conditions: ["PAYMENT_SUCCEEDED", "MAX_RETRIES"],
    };

    it("passes semantic validation for allowed action subsets", () => {
      const result = validateSemantic(baseDecision, "PAYMENT_FAILURE");
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("rejects actions not in the surface's closed AI_DECIDABLE_ACTIONS allowlist", () => {
      // RETRY_PAYMENT is NOT in CHECKOUT_ABANDONMENT allowlist
      const invalidDecision: DecisionRecord = {
        ...baseDecision,
        actions: [{ type: "RETRY_PAYMENT" }],
      };

      const result = validateSemantic(invalidDecision, "CHECKOUT_ABANDONMENT");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain(
        "is not in the allowed action catalog for surface 'CHECKOUT_ABANDONMENT'",
      );
    });

    it("rejects STOP_CASE when combined with other actions", () => {
      const multiActionWithStop: DecisionRecord = {
        ...baseDecision,
        actions: [
          { type: "STOP_CASE", rationale: "Stop" },
          { type: "SEND_EMAIL", rationale: "Email" },
        ],
      };

      const result = validateSemantic(multiActionWithStop, "PAYMENT_FAILURE");
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("STOP_CASE must be the sole recommended action");
    });

    it("enforces RETRY_PAYMENT delay_hours between 1 and 168 hours", () => {
      const invalidDelay: DecisionRecord = {
        ...baseDecision,
        actions: [{ type: "RETRY_PAYMENT", delay_hours: 200 }], // > 168
      };

      const result = validateSemantic(invalidDelay, "PAYMENT_FAILURE");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("delay_hours must be an integer between 1 and 168");
    });

    it("enforces OFFER_INCENTIVE amount_minor <= MAX_AUTO_DISCOUNT_MINOR (500,000 paise / ₹5,000)", () => {
      const excessiveDiscount: DecisionRecord = {
        diagnosis: {
          cause: "price_objection",
          confidence: 0.8,
          rationale: "Discount offered",
        },
        actions: [
          {
            type: "OFFER_INCENTIVE",
            rationale: "6000 INR discount",
            params: {
              kind: "DISCOUNT",
              amount_minor: 600000, // 6000 INR > 5000 INR cap (500_000 paise)
            },
          },
        ],
        stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT"],
      };

      const result = validateSemantic(excessiveDiscount, "CHECKOUT_ABANDONMENT");
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("exceeds maximum policy cap");
    });
  });

  describe("Deterministic Fallback Recommender", () => {
    it("PAYMENT_FAILURE: recommends retry + WhatsApp on high-risk first failure", () => {
      const fallback = generateFallbackDecision({
        riskType: "PAYMENT_FAILURE",
        riskBand: "HIGH",
        priorRetriesCount: 0,
      });

      expect(fallback.diagnosis.cause).toBe("insufficient_funds");
      expect(fallback.actions).toHaveLength(2);
      expect(fallback.actions[0].type).toBe("RETRY_PAYMENT");
      expect(fallback.actions[1].type).toBe("SEND_WHATSAPP");
      expect(fallback.stop_conditions).toEqual([
        "PAYMENT_SUCCEEDED",
        "OPTED_OUT",
        "MAX_RETRIES",
      ]);
    });

    it("PAYMENT_FAILURE: recommends CREATE_HUMAN_TASK when prior retries >= 2", () => {
      const fallback = generateFallbackDecision({
        riskType: "PAYMENT_FAILURE",
        riskBand: "HIGH",
        priorRetriesCount: 2,
      });

      expect(fallback.diagnosis.cause).toBe("stale_card");
      expect(fallback.actions).toHaveLength(1);
      expect(fallback.actions[0].type).toBe("CREATE_HUMAN_TASK");
    });

    it("CHECKOUT_ABANDONMENT: recommends cart reminder email", () => {
      const fallback = generateFallbackDecision({
        riskType: "CHECKOUT_ABANDONMENT",
      });

      expect(fallback.diagnosis.cause).toBe("distraction");
      expect(fallback.actions).toHaveLength(1);
      expect(fallback.actions[0].type).toBe("SEND_EMAIL");
    });

    it("INVOICE_OVERDUE: recommends reminder + payment link when overdue >= 7d", () => {
      const fallback = generateFallbackDecision({
        riskType: "INVOICE_OVERDUE",
        overdueDays: 10,
        amountAtRiskMinor: 48000000,
        currency: "INR",
      });

      expect(fallback.diagnosis.cause).toBe("waiting_for_payday");
      expect(fallback.actions).toHaveLength(2);
      expect(fallback.actions[0].type).toBe("SEND_EMAIL");
      expect(fallback.actions[1].type).toBe("CREATE_PAYMENT_LINK");
      expect((fallback.actions[1] as any).params.amount_minor).toBe(48000000);
    });
  });
});
