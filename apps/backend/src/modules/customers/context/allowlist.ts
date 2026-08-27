/**
 * Customer Context Field Allowlist & PII Redaction/Masking.
 *
 * Single source of truth defining approved projections for the Customer Context (Spec 01 §9, s-13).
 * Anything not allowlisted cannot be included in prompts/logs even by accident.
 */

export const CUSTOMER_CONTEXT_ALLOWLIST = {
  customer: [
    "id",
    "name",
    "status",
    "lifetime_value_minor",
    "tenure_days",
    "opted_out",
    "email_masked",
    "phone_masked",
  ] as const,
  payment_summary: [
    "succeeded_count_180d",
    "failed_count_180d",
    "last_success_at",
    "last_failure_at",
    "last_failure_code",
    "avg_amount_minor",
    "total_paid_minor",
  ] as const,
  subscription_summary: [
    "status",
    "plan_name",
    "amount_minor",
    "renewals_count",
    "past_due_events",
  ] as const,
  invoice_summary: [
    "open_count",
    "overdue_count",
    "worst_days_overdue",
    "total_overdue_minor",
  ] as const,
  checkout_summary: [
    "active_carts",
    "abandoned_count_90d",
    "last_cart_value_minor",
  ] as const,
  recovery_history: [
    "prior_cases",
    "recovered_cases",
    "stopped_cases",
    "escalated_cases",
    "last_outcome",
    "retry_success_rate",
  ] as const,
  communication_history: [
    "whatsapp_last_7d",
    "email_last_14d",
    "sms_last_7d",
    "last_contacted_at",
    "reply_rate",
    "opt_out_at",
  ] as const,
  preferences: [
    "preferred_channel",
    "language",
  ] as const,
} as const;

/**
 * Deterministically masks an email address preserving shape but removing PII:
 * e.g. "john.doe@domain.com" -> "j***@d***.com"
 * e.g. "alice@domain.co.uk" -> "a***@d***.co.uk"
 * e.g. "a@b.co" -> "a***@b***.co"
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email || typeof email !== "string") {
    return null;
  }
  const clean = email.trim();
  const atIndex = clean.indexOf("@");
  if (atIndex <= 0) {
    return null;
  }

  const userPart = clean.slice(0, atIndex);
  const domainPart = clean.slice(atIndex + 1);

  const maskedUser = `${userPart.charAt(0)}***`;

  const dotIndex = domainPart.indexOf(".");
  let maskedDomain: string;
  if (dotIndex > 0) {
    const domainName = domainPart.slice(0, dotIndex);
    const tld = domainPart.slice(dotIndex);
    maskedDomain = `${domainName.charAt(0)}***${tld}`;
  } else {
    maskedDomain = `${domainPart.charAt(0)}***`;
  }

  return `${maskedUser}@${maskedDomain}`;
}

/**
 * Deterministically masks a phone number preserving country prefix / last 4 digits:
 * e.g. "+14155552671" -> "+1***2671"
 * e.g. "+919876543210" -> "+91***3210"
 * e.g. "1234567890" -> "1***7890"
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone || typeof phone !== "string") {
    return null;
  }
  const clean = phone.trim();
  if (clean.length < 6) {
    return "***";
  }

  const digits = clean.replace(/\D/g, "");
  if (digits.length < 6) {
    return clean.startsWith("+") ? "+***" : "***";
  }

  if (clean.startsWith("+")) {
    const dialCodeLen =
      clean.startsWith("+91") ||
      clean.startsWith("+44") ||
      clean.startsWith("+33") ||
      clean.startsWith("+49") ||
      clean.startsWith("+81")
        ? 3
        : 2;
    const prefix = clean.slice(0, dialCodeLen);
    const suffix = digits.slice(-4);
    return `${prefix}***${suffix}`;
  }

  const prefix = digits.slice(0, 1);
  const suffix = digits.slice(-4);
  return `${prefix}***${suffix}`;
}

/**
 * Pure projection helper that picks only approved allowlisted keys.
 * Enforces typed projection rather than mutating or deleting fields after fetch.
 */
export function projectAllowlist<T extends Record<string, any>>(
  source: T,
  allowlist: readonly string[],
): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of allowlist) {
    if (key in source) {
      result[key] = source[key];
    }
  }
  return result;
}
