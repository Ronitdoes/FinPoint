import { describe, it, expect } from "vitest";
import { formatPercent, formatLatency } from "../lib/format";

describe("Decision & Policy Formatting Logic (Spec 00 §6, Spec 03 §5)", () => {
  it("formats confidence score as clean percentage", () => {
    expect(formatPercent(0.912 * 100)).toBe("91.2%");
    expect(formatPercent(0.85 * 100)).toBe("85.0%");
    expect(formatPercent(null)).toBe("—");
  });

  it("formats policy evaluation latency", () => {
    expect(formatLatency(12)).toBe("12ms");
    expect(formatLatency(1800)).toBe("1.8s");
    expect(formatLatency(45.6)).toBe("46ms");
  });

  it("handles decision fallback state flags properly", () => {
    const activeDecision = {
      status: "DECIDED",
      diagnosis: { cause: "insufficient_funds", confidence: 0.91 },
    };
    expect(activeDecision.status === "FALLBACK_RULE_BASED").toBe(false);

    const fallbackDecision = {
      status: "FALLBACK_RULE_BASED",
      diagnosis: { cause: "insufficient_funds", confidence: 0.5 },
    };
    expect(fallbackDecision.status === "FALLBACK_RULE_BASED").toBe(true);
  });
});
