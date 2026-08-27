import { describe, it, expect } from "vitest";
import {
  MODEL_PRICING_TABLE,
  parseTokenUsage,
  computeCostMinorUnits,
} from "./pricing";
import { requiresApproval } from "./confidence";
import { ConfigurationError } from "../../../lib/errors";

describe("AI Governance Unit Tests: Pricing, Accounting & Confidence Hook", () => {
  describe("Token Usage Normalization (parseTokenUsage)", () => {
    it("parses OpenAI usage shape correctly", () => {
      const usage = parseTokenUsage({
        prompt_tokens: 320,
        completion_tokens: 150,
        total_tokens: 470,
      });
      expect(usage).toEqual({
        promptTokens: 320,
        completionTokens: 150,
        totalTokens: 470,
      });
    });

    it("parses Anthropic usage shape correctly", () => {
      const usage = parseTokenUsage({
        input_tokens: 280,
        output_tokens: 110,
      });
      expect(usage).toEqual({
        promptTokens: 280,
        completionTokens: 110,
        totalTokens: 390,
      });
    });

    it("parses Gemini usageMetadata shape correctly", () => {
      const usage = parseTokenUsage({
        promptTokenCount: 400,
        candidatesTokenCount: 200,
        totalTokenCount: 600,
      });
      expect(usage).toEqual({
        promptTokens: 400,
        completionTokens: 200,
        totalTokens: 600,
      });
    });

    it("handles empty or null usage safely", () => {
      expect(parseTokenUsage(null)).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
      expect(parseTokenUsage({})).toEqual({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    });
  });

  describe("Cost Computation (computeCostMinorUnits)", () => {
    it("computes exact integer cost in minor units (paise) for known models", () => {
      // gpt-4o: 21 paise / 1k input, 85 paise / 1k output
      const cost = computeCostMinorUnits(
        { promptTokens: 1000, completionTokens: 1000 },
        "gpt-4o",
      );
      expect(cost).toBe(106n); // 21 + 85 = 106 paise
    });

    it("rounds partial thousand token units ceiling-safe", () => {
      // 500 prompt tokens of gpt-4o: ceil(500 * 21 / 1000) = ceil(10.5) = 11 paise
      // 500 completion tokens: ceil(500 * 85 / 1000) = ceil(42.5) = 43 paise
      const cost = computeCostMinorUnits(
        { promptTokens: 500, completionTokens: 500 },
        "gpt-4o",
      );
      expect(cost).toBe(54n); // 11 + 43
    });

    it("returns 0n for zero tokens without errors", () => {
      const cost = computeCostMinorUnits(
        { promptTokens: 0, completionTokens: 0 },
        "gpt-4o",
      );
      expect(cost).toBe(0n);
    });

    it("fails CLOSED and throws ConfigurationError when model is unconfigured", () => {
      expect(() => {
        computeCostMinorUnits(
          { promptTokens: 100, completionTokens: 50 },
          "unregistered-custom-llm",
        );
      }).toThrow(ConfigurationError);
    });
  });

  describe("Confidence Hook Contract (requiresApproval)", () => {
    it("returns true for low confidence (0.4) + RETRY_PAYMENT", () => {
      const result = requiresApproval({
        diagnosis: { confidence: 0.4, cause: "insufficient_funds" },
        actions: [{ type: "RETRY_PAYMENT", delay_hours: 24 }],
      });
      expect(result).toBe(true);
    });

    it("returns false for high confidence (0.9) + SEND_EMAIL", () => {
      const result = requiresApproval({
        diagnosis: { confidence: 0.9, cause: "routine_delay" },
        actions: [{ type: "SEND_EMAIL", params: { template: "reminder" } }],
      });
      expect(result).toBe(false);
    });

    it("returns true for OFFER_INCENTIVE regardless of high confidence", () => {
      const result = requiresApproval({
        diagnosis: { confidence: 0.99, cause: "price_hesitation" },
        actions: [{ type: "OFFER_INCENTIVE", params: { discount_pct: 10 } }],
      });
      expect(result).toBe(true);
    });

    it("returns false for high confidence (0.85) + RETRY_PAYMENT", () => {
      const result = requiresApproval({
        diagnosis: { confidence: 0.85, cause: "insufficient_funds" },
        actions: [{ type: "RETRY_PAYMENT", delay_hours: 48 }],
      });
      expect(result).toBe(false);
    });

    it("handles string actions and null values gracefully", () => {
      expect(requiresApproval(null)).toBe(false);
      expect(
        requiresApproval({
          diagnosisConfidence: 0.3,
          recommendedActions: ["CREATE_PAYMENT_LINK"],
        }),
      ).toBe(true);
    });
  });
});
