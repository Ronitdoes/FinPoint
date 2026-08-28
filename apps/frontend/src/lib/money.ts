/**
 * Money and Currency formatting utilities for the Financial Control Plane (Spec 00 §6, Spec 03 §7, ADR-009).
 * All monetary amounts are handled strictly as integer minor units (paise / cents).
 */

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: "₹",
  USD: "$",
  EUR: "€",
  GBP: "£",
};

/**
 * Formats minor units (e.g. paise) to standard display string with Indian number system grouping for INR.
 * Example (INR):
 *   1299900 -> "₹12,999"
 *   48000000 -> "₹4,80,000"
 *   123456789 -> "₹12,34,567.89"
 */
export function formatMoney(
  minorUnits: number | string | bigint | null | undefined,
  currency: string = "INR",
  opts: { showDecimals?: boolean; compact?: boolean } = {},
): string {
  if (minorUnits === null || minorUnits === undefined) {
    return "—";
  }

  const symbol = CURRENCY_SYMBOLS[currency] ?? `${currency} `;
  let value: number;

  if (typeof minorUnits === "bigint") {
    value = Number(minorUnits);
  } else if (typeof minorUnits === "string") {
    value = Number(minorUnits);
  } else {
    value = minorUnits;
  }

  if (isNaN(value)) {
    return "—";
  }

  const isNegative = value < 0;
  const absMajor = Math.abs(value) / 100;

  if (opts.compact) {
    return `${isNegative ? "-" : ""}${symbol}${formatCompactNumber(absMajor, currency)}`;
  }

  const parts = absMajor.toFixed(opts.showDecimals ? 2 : 0).split(".");
  const integerPart = parts[0];
  const decimalPart = parts[1];

  let formattedInteger: string;

  if (currency === "INR") {
    // Indian grouping: last 3 digits, then groups of 2 digits
    const lastThree = integerPart.slice(-3);
    const otherNumbers = integerPart.slice(0, -3);
    formattedInteger =
      otherNumbers !== ""
        ? otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + "," + lastThree
        : lastThree;
  } else {
    // Standard international 3-digit grouping
    formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  const formattedAmount =
    opts.showDecimals && decimalPart && decimalPart !== "00"
      ? `${formattedInteger}.${decimalPart}`
      : formattedInteger;

  return `${isNegative ? "-" : ""}${symbol}${formattedAmount}`;
}

/**
 * Compact Indian / Western notation:
 * INR:
 *   >= 1,00,00,000 -> Cr (Crore)
 *   >= 1,00,000 -> L (Lakh)
 *   >= 1,000 -> K (Thousand)
 * Other:
 *   >= 1,000,000 -> M
 *   >= 1,000 -> K
 */
export function formatCompactNumber(amountInMajorUnits: number, currency: string = "INR"): string {
  if (currency === "INR") {
    if (amountInMajorUnits >= 10000000) {
      const cr = amountInMajorUnits / 10000000;
      return `${trimTrailingZeros(cr.toFixed(2))}Cr`;
    }
    if (amountInMajorUnits >= 100000) {
      const l = amountInMajorUnits / 100000;
      return `${trimTrailingZeros(l.toFixed(2))}L`;
    }
    if (amountInMajorUnits >= 1000) {
      const k = amountInMajorUnits / 1000;
      return `${trimTrailingZeros(k.toFixed(1))}K`;
    }
  } else {
    if (amountInMajorUnits >= 1000000) {
      const m = amountInMajorUnits / 1000000;
      return `${trimTrailingZeros(m.toFixed(2))}M`;
    }
    if (amountInMajorUnits >= 1000) {
      const k = amountInMajorUnits / 1000;
      return `${trimTrailingZeros(k.toFixed(1))}K`;
    }
  }

  return amountInMajorUnits.toLocaleString("en-IN");
}

function trimTrailingZeros(numStr: string): string {
  return numStr.replace(/(\.[0-9]*[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

/**
 * Parses rupee or major unit string into minor units integer.
 */
export function toMinorUnits(majorAmount: number | string): number {
  const num = typeof majorAmount === "string" ? parseFloat(majorAmount) : majorAmount;
  return Math.round(num * 100);
}
