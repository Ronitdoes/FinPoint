import { describe, it, expect } from "vitest";
import { formatMoney, formatCompactNumber, toMinorUnits } from "../lib/money";

describe("Frontend Money Formatting (Spec 00 §6, Spec 03 §7, ADR-009)", () => {
  it("formats integer minor units to standard Indian currency string", () => {
    // ₹12,999 (1299900 minor units)
    expect(formatMoney(1299900, "INR")).toBe("₹12,999");

    // ₹4,80,000 (48000000 minor units)
    expect(formatMoney(48000000, "INR")).toBe("₹4,80,000");

    // ₹12,34,567.89 with decimals
    expect(formatMoney("123456789", "INR", { showDecimals: true })).toBe("₹12,34,567.89");
  });

  it("formats executive compact notation (Lakh and Crore grouping)", () => {
    // ₹12.8L (128000000 minor units = 12.8 Lakh)
    expect(formatMoney(128000000, "INR", { compact: true })).toBe("₹12.8L");
    expect(formatCompactNumber(1280000, "INR")).toBe("12.8L");

    // ₹8.4L (84000000 minor units)
    expect(formatMoney(84000000, "INR", { compact: true })).toBe("₹8.4L");
    expect(formatCompactNumber(840000, "INR")).toBe("8.4L");

    // ₹72K (7200000 minor units)
    expect(formatMoney(7200000, "INR", { compact: true })).toBe("₹72K");

    // ₹7.68L (76800000 minor units)
    expect(formatMoney(76800000, "INR", { compact: true })).toBe("₹7.68L");

    // ₹4.8Cr (4800000000 minor units = 4.8 Crore)
    expect(formatMoney(4800000000, "INR", { compact: true })).toBe("₹4.8Cr");
  });

  it("handles other currencies properly (USD, EUR, GBP)", () => {
    expect(formatMoney(129900, "USD")).toBe("$1,299");
    expect(formatMoney(129900, "EUR")).toBe("€1,299");
    expect(formatMoney(129900, "GBP")).toBe("£1,299");
  });

  it("handles null, undefined, and zero gracefully", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
    expect(formatMoney(0, "INR")).toBe("₹0");
  });

  it("converts major amounts to minor units", () => {
    expect(toMinorUnits(12999)).toBe(1299900);
    expect(toMinorUnits("480000")).toBe(48000000);
    expect(toMinorUnits(12.5)).toBe(1250);
  });
});
