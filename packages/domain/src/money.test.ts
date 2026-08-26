import { describe, expect, it } from "vitest";

import {
  MoneyError,
  addMinorUnits,
  compareMinorUnits,
  formatMinorUnits,
  getCurrencyExponent,
  minorUnits,
  parseAmountToMinorUnits,
  subtractMinorUnits,
} from "./money";

describe("getCurrencyExponent", () => {
  it("returns 0/2/3 per ISO-4217 exponent", () => {
    expect(getCurrencyExponent("JPY")).toBe(0);
    expect(getCurrencyExponent("KRW")).toBe(0);
    expect(getCurrencyExponent("INR")).toBe(2);
    expect(getCurrencyExponent("USD")).toBe(2);
    expect(getCurrencyExponent("BHD")).toBe(3);
    expect(getCurrencyExponent("KWD")).toBe(3);
  });

  it("rejects malformed currency codes", () => {
    expect(() => getCurrencyExponent("usd")).toThrow(MoneyError);
    expect(() => getCurrencyExponent("US")).toThrow(MoneyError);
    expect(() => getCurrencyExponent("USDD")).toThrow(MoneyError);
    expect(() => getCurrencyExponent("")).toThrow(MoneyError);
  });
});

describe("parseAmountToMinorUnits", () => {
  it.each([
    ["1250", 125000n],
    ["1250.5", 125050n],
    ["0.01", 1n],
    ["4.35", 435n],
    ["-4.50", -450n],
    ["007", 700n],
    [".99", 99n],
    ["2.", 200n],
    ["500", 50000n],
  ])("parses %s (INR)", (input, expected) => {
    expect(parseAmountToMinorUnits(input, "INR")).toBe(expected);
  });

  it("truncates extra sub-minor-unit digits instead of rounding", () => {
    expect(parseAmountToMinorUnits("4.999", "INR")).toBe(499n);
    expect(parseAmountToMinorUnits("0.0049", "INR")).toBe(0n);
    expect(parseAmountToMinorUnits("-1.999", "USD")).toBe(-199n);
  });

  it("respects the currency exponent", () => {
    expect(parseAmountToMinorUnits("123456", "JPY")).toBe(123456n);
    expect(parseAmountToMinorUnits("12.34", "JPY")).toBe(12n);
    expect(parseAmountToMinorUnits("1.2", "BHD")).toBe(1200n);
    expect(parseAmountToMinorUnits("1.2345", "BHD")).toBe(1234n);
  });

  it("parses integer numbers without float drift", () => {
    expect(parseAmountToMinorUnits(4.35, "INR")).toBe(435n);
    expect(parseAmountToMinorUnits(19.99, "USD")).toBe(1999n);
    expect(parseAmountToMinorUnits(100, "INR")).toBe(10000n);
  });

  it.each(["", ".", "abc", "1,234", "₹500", "1.2.3", "--5", "1e3"])(
    "rejects unparseable string %s",
    (input) => {
      expect(() => parseAmountToMinorUnits(input, "INR")).toThrow(MoneyError);
    },
  );

  it("rejects non-finite and non-integer numeric inputs at the boundary", () => {
    expect(() => minorUnits(10.5)).toThrow(MoneyError);
    expect(() => parseAmountToMinorUnits(Number.NaN, "INR")).toThrow(MoneyError);
    expect(() => parseAmountToMinorUnits(Number.POSITIVE_INFINITY, "INR")).toThrow(
      MoneyError,
    );
  });
});

describe("formatMinorUnits", () => {
  it.each([
    [125000n, "INR", "\u20B91,250.00"],
    [500000n, "INR", "\u20B95,000.00"],
    [-250n, "INR", "-\u20B92.50"],
    [1n, "USD", "$0.01"],
    [123456789n, "USD", "$1,234,567.89"],
    [500n, "JPY", "\u00A5500"],
    [1500n, "BHD", "BHD 1.500"],
    [0n, "INR", "\u20B90.00"],
  ])("formats %d %s as %s", (amount, currency, expected) => {
    expect(formatMinorUnits(amount, currency)).toBe(expected);
  });

  it("round-trips parse -> format within one exponent", () => {
    const minor = parseAmountToMinorUnits("17255.5", "INR");
    expect(minor).toBe(1725550n);
    expect(formatMinorUnits(minor, "INR")).toBe("\u20B917,255.50");
  });
});

describe("integer-only arithmetic", () => {
  it("adds, subtracts and compares exact integers", () => {
    const a = minorUnits(300);
    const b = minorUnits(450);
    expect(addMinorUnits(a, b)).toBe(750n);
    expect(subtractMinorUnits(b, a)).toBe(150n);
    expect(compareMinorUnits(a, b)).toBe(-1);
    expect(compareMinorUnits(a, a)).toBe(0);
    expect(compareMinorUnits(b, a)).toBe(1);
  });
});
