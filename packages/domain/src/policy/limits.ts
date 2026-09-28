export const MAX_PAYMENT_RETRIES = 3;
export const MAX_WHATSAPP_PER_7_DAYS = 2;
export const MAX_EMAIL_PER_14_DAYS = 3;
export const MAX_AUTO_DISCOUNT_MINOR = 500_000;
export const HIGH_VALUE_APPROVAL_MINOR = 10_000_000;

/**
 * Single source of truth for the confidence-gate high-stakes action set (s-15).
 * Shared by the governance `requiresApproval(decision)` hook
 * (apps/backend ai/governance/confidence.ts) and the policy `POL-CONFIDENCE`
 * compiled evaluator (packages/policy rules/confidence.ts) so the two can never
 * drift. Matches the s-15 requiresApproval rule v1 and the POL-CONFIDENCE
 * `applies_to` list exactly.
 */
export const HIGH_STAKES_CONFIDENCE_ACTIONS: ReadonlySet<string> = new Set([
  "RETRY_PAYMENT",
  "CREATE_PAYMENT_LINK",
  "OFFER_INCENTIVE",
]);
