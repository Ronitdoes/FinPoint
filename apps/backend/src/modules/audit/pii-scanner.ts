/**
 * PII and Secret Scanner for Compliance & Audit Trail (Spec 01 §18, Step 25).
 * Detects unmasked emails, phone numbers, payment card numbers, and secret tokens in metadata/payloads.
 */

export interface PiiViolation {
  path: string;
  pattern: "EMAIL" | "PHONE" | "CARD" | "SECRET";
  sample: string;
}

export interface PiiScanResult {
  hasPii: boolean;
  violations: PiiViolation[];
}

const RAW_EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const RAW_PHONE_REGEX = /^(\+?[1-9]\d{7,14}|\b[6-9]\d{9}\b|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b)$/;
const RAW_CARD_REGEX = /^(?:\d{4}[ -]?){3}\d{4}$|^\d{13,19}$/;
const SECRET_REGEX = /(?:sk_live_[0-9a-zA-Z]{16,}|sk_test_[0-9a-zA-Z]{16,}|whsec_[0-9a-zA-Z]{16,}|rzp_live_[0-9a-zA-Z]{16,}|rrk_[0-9a-zA-Z_]{20,}|Bearer\s+[a-zA-Z0-9._-]{20,})/i;

const ALLOWLISTED_PII_KEYS = new Set([
  "maskedemail",
  "maskedphone",
  "maskedcard",
  "emailmasked",
  "phonemasked",
  "customeremailmasked",
  "customerphonemasked",
  "last4",
  "brand",
  "expmonth",
  "expyear",
  "currency",
]);

/**
 * Masks an email address into allowlisted form (e.g., "j***@example.com").
 */
export function maskEmail(email: string): string {
  if (!email || typeof email !== "string") return email;
  const parts = email.trim().split("@");
  if (parts.length !== 2) return "***@***";
  const [local, domain] = parts;
  if (!local || !domain) return "***@***";
  if (local.length <= 2) {
    return `${local[0]}***@${domain}`;
  }
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/**
 * Masks a phone number into allowlisted form (e.g., "+91 98765*****").
 */
export function maskPhone(phone: string): string {
  if (!phone || typeof phone !== "string") return phone;
  const cleaned = phone.trim();
  if (cleaned.length <= 4) return "****";
  const start = cleaned.slice(0, Math.min(5, cleaned.length - 4));
  return `${start}*****`;
}

/**
 * Masks a card number into allowlisted form (e.g., "**** **** **** 1234").
 */
export function maskCard(card: string): string {
  if (!card || typeof card !== "string") return card;
  const digitsOnly = card.replace(/\D/g, "");
  if (digitsOnly.length < 4) return "****";
  const last4 = digitsOnly.slice(-4);
  return `**** **** **** ${last4}`;
}

/**
 * Scans an arbitrary data structure for unmasked PII or secrets.
 */
export function scanForPii(data: unknown, currentPath = ""): PiiScanResult {
  const violations: PiiViolation[] = [];

  function traverse(value: unknown, path: string) {
    if (value === null || value === undefined) return;

    if (typeof value === "string") {
      const trimmed = value.trim();
      const normalizedPathKey = path.split(".").pop()?.toLowerCase() || "";

      // Allow allowlisted key names if the value is already masked or only last4
      if (ALLOWLISTED_PII_KEYS.has(normalizedPathKey)) {
        if (normalizedPathKey === "last4" && /^\d{4}$/.test(trimmed)) {
          return;
        }
        if (trimmed.includes("*")) {
          return;
        }
      }

      // Check for raw secret keys
      if (SECRET_REGEX.test(trimmed)) {
        violations.push({
          path,
          pattern: "SECRET",
          sample: trimmed.slice(0, 10) + "...",
        });
        return;
      }

      // If string is already masked with '*', don't flag as raw PII
      if (trimmed.includes("*")) {
        return;
      }

      // Check for raw unmasked email
      if (RAW_EMAIL_REGEX.test(trimmed)) {
        violations.push({
          path,
          pattern: "EMAIL",
          sample: maskEmail(trimmed),
        });
        return;
      }

      // Check for raw credit card
      const digitsOnly = trimmed.replace(/[\s-]/g, "");
      if (
        (RAW_CARD_REGEX.test(trimmed) || (digitsOnly.length >= 13 && digitsOnly.length <= 19 && /^\d+$/.test(digitsOnly))) &&
        !normalizedPathKey.includes("id") &&
        !normalizedPathKey.includes("timestamp") &&
        !normalizedPathKey.includes("amount")
      ) {
        violations.push({
          path,
          pattern: "CARD",
          sample: maskCard(trimmed),
        });
        return;
      }

      // Check for raw phone number
      if (
        RAW_PHONE_REGEX.test(trimmed) &&
        !normalizedPathKey.includes("id") &&
        !normalizedPathKey.includes("amount") &&
        !normalizedPathKey.includes("version")
      ) {
        violations.push({
          path,
          pattern: "PHONE",
          sample: maskPhone(trimmed),
        });
        return;
      }
    } else if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        traverse(value[i], `${path}[${i}]`);
      }
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const nextPath = path ? `${path}.${k}` : k;
        traverse(v, nextPath);
      }
    }
  }

  traverse(data, currentPath);

  return {
    hasPii: violations.length > 0,
    violations,
  };
}

/**
 * Deeply sanitizes / redacts an object's payload against unmasked PII.
 */
export function redactPii<T>(data: T): T {
  if (data === null || data === undefined) return data;

  if (typeof data === "string") {
    let str = data;
    if (SECRET_REGEX.test(str)) {
      return "[REDACTED_SECRET]" as unknown as T;
    }
    if (!str.includes("*")) {
      if (RAW_EMAIL_REGEX.test(str)) {
        return maskEmail(str) as unknown as T;
      }
      if (RAW_CARD_REGEX.test(str)) {
        return maskCard(str) as unknown as T;
      }
    }
    return str as unknown as T;
  }

  if (Array.isArray(data)) {
    return data.map((item) => redactPii(item)) as unknown as T;
  }

  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes("password") || lowerKey.includes("secret") || lowerKey.includes("token") && !lowerKey.includes("count")) {
        result[key] = "[REDACTED]";
      } else if (lowerKey.includes("email") && typeof val === "string") {
        result[key] = maskEmail(val);
      } else if (lowerKey.includes("phone") && typeof val === "string") {
        result[key] = maskPhone(val);
      } else if ((lowerKey.includes("card") || lowerKey.includes("pan")) && typeof val === "string" && !lowerKey.includes("id")) {
        result[key] = maskCard(val);
      } else {
        result[key] = redactPii(val);
      }
    }
    return result as unknown as T;
  }

  return data;
}
