import type { CustomerContext } from "./types";

/**
 * Maximum serialized byte budget for Customer Context (Spec 01 §9, s-13).
 */
export const MAX_CONTEXT_BYTES = 8192; // 8KB strict budget

export interface TrimResult {
  context: CustomerContext;
  trimmed: boolean;
  bytes: number;
  stepsApplied: number;
}

/**
 * Trims a customer context object deterministically when its serialized UTF-8 byte length
 * exceeds MAX_CONTEXT_BYTES (8KB), adhering strictly to the documented drop order:
 *
 * Drop order:
 * 1. checkout_summary details (last_cart_value_minor = 0)
 * 2. invoice_summary details (worst_days_overdue = 0)
 * 3. recovery_history.last_outcome (set to null)
 * 4. payment_summary.last_* timestamps (last_success_at = null, last_failure_at = null)
 * 5. communication_history.reply_rate (set to 0)
 *
 * Invariants (NEVER DROPPED):
 * - customer.opted_out
 * - recovery_history.prior_cases (and case counts)
 * - payment_summary.last_failure_code
 * - communication_history contact frequency counters (whatsapp_last_7d, email_last_14d, sms_last_7d)
 */
export function trimContextToBudget(context: CustomerContext): TrimResult {
  // Deep clone to avoid mutating input directly
  const ctx: CustomerContext = JSON.parse(JSON.stringify(context));

  let serialized = JSON.stringify(ctx);
  let bytes = Buffer.byteLength(serialized, "utf8");

  if (bytes <= MAX_CONTEXT_BYTES) {
    return {
      context: ctx,
      trimmed: false,
      bytes,
      stepsApplied: 0,
    };
  }

  let steps = 0;

  // Step 1: Drop checkout details
  ctx.checkout_summary.last_cart_value_minor = 0;
  steps++;
  bytes = Buffer.byteLength(JSON.stringify(ctx), "utf8");
  if (bytes <= MAX_CONTEXT_BYTES) {
    return { context: ctx, trimmed: true, bytes, stepsApplied: steps };
  }

  // Step 2: Drop invoice history/details
  ctx.invoice_summary.worst_days_overdue = 0;
  steps++;
  bytes = Buffer.byteLength(JSON.stringify(ctx), "utf8");
  if (bytes <= MAX_CONTEXT_BYTES) {
    return { context: ctx, trimmed: true, bytes, stepsApplied: steps };
  }

  // Step 3: Drop recovery last outcome
  ctx.recovery_history.last_outcome = null;
  steps++;
  bytes = Buffer.byteLength(JSON.stringify(ctx), "utf8");
  if (bytes <= MAX_CONTEXT_BYTES) {
    return { context: ctx, trimmed: true, bytes, stepsApplied: steps };
  }

  // Step 4: Drop payment last_* timestamps (retaining last_failure_code)
  ctx.payment_summary.last_success_at = null;
  ctx.payment_summary.last_failure_at = null;
  steps++;
  bytes = Buffer.byteLength(JSON.stringify(ctx), "utf8");
  if (bytes <= MAX_CONTEXT_BYTES) {
    return { context: ctx, trimmed: true, bytes, stepsApplied: steps };
  }

  // Step 5: Drop communication reply_rate
  ctx.communication_history.reply_rate = 0;
  steps++;
  bytes = Buffer.byteLength(JSON.stringify(ctx), "utf8");

  return {
    context: ctx,
    trimmed: true,
    bytes,
    stepsApplied: steps,
  };
}
