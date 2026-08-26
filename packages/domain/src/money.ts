import { z } from "zod";

declare const minorUnitsBrand: unique symbol;

export type MinorUnits = bigint & {
  readonly [minorUnitsBrand]: "MinorUnits";
};

export class MoneyError extends Error {
  readonly code = "MONEY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

const ZERO_DECIMAL_CURRENCIES = ["JPY", "KRW", "VND", "CLP"] as const;
const THREE_DECIMAL_CURRENCIES = [
  "BHD",
  "IQD",
  "JOD",
  "KWD",
  "LYD",
  "OMR",
  "TND",
] as const;

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "\u20AC",
  GBP: "\u00A3",
  INR: "\u20B9",
  JPY: "\u00A5",
  CNY: "\u00A5",
};

export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/u, "currency must be an upper-case ISO-4217 code");

export function getCurrencyExponent(currency: string): 0 | 2 | 3 {
  if (!currencyCodeSchema.safeParse(currency).success) {
    throw new MoneyError(`invalid currency code: ${currency}`);
  }
  if ((ZERO_DECIMAL_CURRENCIES as readonly string[]).includes(currency)) {
    return 0;
  }
  if ((THREE_DECIMAL_CURRENCIES as readonly string[]).includes(currency)) {
    return 3;
  }
  return 2;
}

export function minorUnits(value: number | bigint): MinorUnits {
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new MoneyError(`amount must be an integer number of minor units: ${value}`);
  }
  return BigInt(value) as MinorUnits;
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function toPlainString(input: number): string {
  let text = String(input);
  let negative = false;
  if (text.startsWith("-")) {
    negative = true;
    text = text.slice(1);
  }
  const exponentIndex = text.search(/[eE]/u);
  if (exponentIndex === -1) {
    return negative ? `-${text}` : text;
  }
  const coefficient = text.slice(0, exponentIndex);
  const exponent = Number(text.slice(exponentIndex + 1));
  const dotIndex = coefficient.indexOf(".");
  let digits: string;
  let pointPosition: number;
  if (dotIndex === -1) {
    digits = coefficient;
    pointPosition = digits.length;
  } else {
    digits = coefficient.slice(0, dotIndex) + coefficient.slice(dotIndex + 1);
    pointPosition = dotIndex;
  }
  pointPosition += exponent;
  let result: string;
  if (pointPosition <= 0) {
    result = `0.${"0".repeat(-pointPosition)}${digits}`;
  } else if (pointPosition >= digits.length) {
    result = digits + "0".repeat(pointPosition - digits.length);
  } else {
    result = `${digits.slice(0, pointPosition)}.${digits.slice(pointPosition)}`;
  }
  return negative ? `-${result}` : result;
}

export function parseAmountToMinorUnits(
  input: string | number,
  currency: string,
): MinorUnits {
  const exponent = getCurrencyExponent(currency);

  let text: string;
  if (typeof input === "string") {
    text = input.trim();
  } else {
    if (!Number.isFinite(input)) {
      throw new MoneyError(`amount must be finite: ${input}`);
    }
    text = toPlainString(input);
  }

  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/u.exec(text);
  if (!match || (match[2] === "" && (match[3] === undefined || match[3] === ""))) {
    throw new MoneyError(`unparseable amount for ${currency}: ${text}`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const integerPart = match[2] === "" ? "0" : match[2];
  const fractionPart = (match[3] ?? "").slice(0, exponent).padEnd(exponent, "0");
  const scaled = BigInt(integerPart + fractionPart);

  return (sign * scaled) as MinorUnits;
}

export function formatMinorUnits(
  amount: MinorUnits | number | bigint,
  currency: string,
): string {
  const exponent = getCurrencyExponent(currency);
  const value =
    typeof amount === "bigint"
      ? amount
      : minorUnits(amount);
  const divisor = pow10(exponent);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const wholePart = absolute / divisor;
  const fractionPart = absolute % divisor;
  const groupedWhole = wholePart.toString().replace(
    /\B(?=(\d{3})+(?!\d))/gu,
    ",",
  );
  const body =
    exponent === 0
      ? groupedWhole
      : `${groupedWhole}.${fractionPart.toString().padStart(exponent, "0")}`;
  const sign = negative ? "-" : "";
  return `${sign}${CURRENCY_SYMBOLS[currency] ?? `${currency} `}${body}`;
}

export function addMinorUnits(a: MinorUnits, b: MinorUnits): MinorUnits {
  return (a + b) as MinorUnits;
}

export function subtractMinorUnits(a: MinorUnits, b: MinorUnits): MinorUnits {
  return (a - b) as MinorUnits;
}

export function compareMinorUnits(a: MinorUnits, b: MinorUnits): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
