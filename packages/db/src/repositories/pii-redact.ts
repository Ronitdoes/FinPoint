/**
 * Write-path PII/secret sanitizer for audit writes (s-25 MED fix).
 *
 * `recordAuditLog` (metadata) and `recordCaseEvent` (payload/description) run
 * every value through `sanitizePii` BEFORE insert so the stored row never holds
 * raw emails, phone numbers, card PANs, or secret tokens. This is the write-path
 * counterpart to the read-path `redactPii` in
 * `apps/backend/src/modules/audit/pii-scanner.ts` (timeline enrichment masks on
 * read as defense-in-depth).
 *
 * The implementation is intentionally self-contained (regexes duplicated, no
 * imports): `@repo/db` cannot import from `apps/backend` (dependency inversion
 * — backend depends on db), so the patterns are mirrored here. Keep the two in
 * sync per CONVENTIONS §7 (deny-by-default PII/secrets redaction) and §12.
 */

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const PHONE_RE =
  /^(\+?[1-9]\d{7,14}|\b[6-9]\d{9}\b|\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b)$/;
const CARD_RE = /^(?:\d{4}[ -]?){3}\d{4}$|^\d{13,19}$/;
const SECRET_RE =
  /(?:sk_live_[0-9a-zA-Z]{16,}|sk_test_[0-9a-zA-Z]{16,}|whsec_[0-9a-zA-Z]{16,}|rzp_live_[0-9a-zA-Z]{16,}|rrk_[0-9a-zA-Z_]{20,}|Bearer\s+[a-zA-Z0-9._-]{20,})/i;

/** Masks an email into allowlisted form (e.g. "j***e@example.com"). */
export function maskPiiEmail(email: string): string {
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

/** Masks a phone number into allowlisted form (e.g. "+91 98765*****"). */
export function maskPiiPhone(phone: string): string {
  if (!phone || typeof phone !== "string") return phone;
  const cleaned = phone.trim();
  if (cleaned.length <= 4) return "****";
  const start = cleaned.slice(0, Math.min(5, cleaned.length - 4));
  return `${start}*****`;
}

/** Masks a card PAN into allowlisted form (e.g. "**** **** **** 1234"). */
export function maskPiiCard(card: string): string {
  if (!card || typeof card !== "string") return card;
  const digitsOnly = card.replace(/\D/g, "");
  if (digitsOnly.length < 4) return "****";
  const last4 = digitsOnly.slice(-4);
  return `**** **** **** ${last4}`;
}

function sanitizeString(value: string): string {
  const trimmed = value.trim();
  // Secrets match as substrings (tokens are usually embedded in larger text).
  if (SECRET_RE.test(value)) {
    return "[REDACTED_SECRET]";
  }
  // Already-masked values pass through untouched.
  if (trimmed.includes("*")) {
    return value;
  }
  if (EMAIL_RE.test(trimmed)) {
    return maskPiiEmail(value);
  }
  if (CARD_RE.test(trimmed)) {
    return maskPiiCard(value);
  }
  if (PHONE_RE.test(trimmed)) {
    return maskPiiPhone(value);
  }
  return value;
}

/**
 * Recursively redacts PII/secrets from an arbitrary JSON-compatible value.
 * Objects are masked by key name (email/phone/card/secret/token/password) when
 * the value matches the corresponding shape, and every nested string is
 * checked against the email/phone/card/secret patterns. Non-PII values
 * (including already-masked strings) are returned unchanged.
 */
export function sanitizePii<T>(data: T): T {
  if (data === null || data === undefined) return data;

  if (typeof data === "string") {
    return sanitizeString(data) as unknown as T;
  }

  if (Array.isArray(data)) {
    return data.map((item) => sanitizePii(item)) as unknown as T;
  }

  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(data as Record<string, unknown>)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes("password") ||
        lowerKey.includes("secret") ||
        (lowerKey.includes("token") && !lowerKey.includes("count"))
      ) {
        result[key] = "[REDACTED]";
      } else if (lowerKey.includes("email") && typeof val === "string") {
        const t = val.trim();
        result[key] =
          !t.includes("*") && EMAIL_RE.test(t)
            ? maskPiiEmail(val)
            : sanitizePii(val);
      } else if (lowerKey.includes("phone") && typeof val === "string") {
        const t = val.trim();
        result[key] =
          !t.includes("*") && PHONE_RE.test(t)
            ? maskPiiPhone(val)
            : sanitizePii(val);
      } else if (
        (lowerKey.includes("card") || lowerKey.includes("pan")) &&
        typeof val === "string" &&
        !lowerKey.includes("id")
      ) {
        const t = val.trim();
        result[key] =
          !t.includes("*") && CARD_RE.test(t)
            ? maskPiiCard(val)
            : sanitizePii(val);
      } else {
        result[key] = sanitizePii(val);
      }
    }
    return result as unknown as T;
  }

  return data;
}
