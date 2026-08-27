import { describe, it, expect } from "vitest";
import { trimContextToBudget, MAX_CONTEXT_BYTES } from "./trim";
import type { CustomerContext } from "./types";

describe("Step 13: Customer Context Budget Trimming", () => {
  function createStandardContext(): CustomerContext {
    return {
      built_at: "2026-08-27T12:00:00.000Z",
      customer: {
        id: "a0000000-0000-0000-0000-000000000001",
        name: "Standard Customer",
        status: "ACTIVE",
        lifetime_value_minor: 50000,
        tenure_days: 120,
        opted_out: true,
        email_masked: "s***@e***.com",
        phone_masked: "+1***2345",
      },
      payment_summary: {
        succeeded_count_180d: 5,
        failed_count_180d: 1,
        last_success_at: "2026-08-20T12:00:00.000Z",
        last_failure_at: "2026-08-25T12:00:00.000Z",
        last_failure_code: "insufficient_funds",
        avg_amount_minor: 5000,
        total_paid_minor: 25000,
      },
      subscription_summary: {
        status: "ACTIVE",
        plan_name: "Pro Plan",
        amount_minor: 5000,
        renewals_count: 5,
        past_due_events: 1,
      },
      invoice_summary: {
        open_count: 2,
        overdue_count: 1,
        worst_days_overdue: 14,
        total_overdue_minor: 10000,
      },
      checkout_summary: {
        active_carts: 1,
        abandoned_count_90d: 2,
        last_cart_value_minor: 7500,
      },
      recovery_history: {
        prior_cases: 3,
        recovered_cases: 2,
        stopped_cases: 1,
        escalated_cases: 0,
        last_outcome: {
          case_id: "c0000000-0000-0000-0000-000000000001",
          amount_recovered_minor: 5000,
          at: "2026-08-20T12:00:00.000Z",
        },
        retry_success_rate: 0.6667,
      },
      communication_history: {
        whatsapp_last_7d: 2,
        email_last_14d: 3,
        sms_last_7d: 1,
        last_contacted_at: "2026-08-25T12:00:00.000Z",
        reply_rate: 0.5,
        opt_out_at: "2026-08-26T12:00:00.000Z",
      },
      preferences: {
        preferred_channel: "WHATSAPP",
        language: "en",
      },
    };
  }

  it("leaves standard context unmodified when within 8KB budget", () => {
    const ctx = createStandardContext();
    const result = trimContextToBudget(ctx);

    expect(result.trimmed).toBe(false);
    expect(result.stepsApplied).toBe(0);
    expect(result.bytes).toBeLessThanOrEqual(MAX_CONTEXT_BYTES);
    expect(result.context).toEqual(ctx);
  });

  it("applies deterministic drop priority when context exceeds 8KB", () => {
    const ctx = createStandardContext();
    // Artificially enlarge customer name to push overall payload slightly over 8KB
    // 8192 bytes limit
    ctx.customer.name = "X".repeat(8100);

    const result = trimContextToBudget(ctx);

    expect(result.trimmed).toBe(true);
    expect(result.stepsApplied).toBeGreaterThan(0);

    // Step 1: checkout_summary.last_cart_value_minor dropped to 0
    expect(result.context.checkout_summary.last_cart_value_minor).toBe(0);

    // Invariants MUST remain intact
    expect(result.context.customer.opted_out).toBe(true);
    expect(result.context.recovery_history.prior_cases).toBe(3);
    expect(result.context.payment_summary.last_failure_code).toBe("insufficient_funds");
    expect(result.context.communication_history.whatsapp_last_7d).toBe(2);
    expect(result.context.communication_history.email_last_14d).toBe(3);
    expect(result.context.communication_history.sms_last_7d).toBe(1);
  });

  it("never drops critical policy-gating invariants even under maximum trimming", () => {
    const ctx = createStandardContext();
    // Massively oversized payload that forces all 5 trimming steps to execute
    ctx.customer.name = "A".repeat(15000);

    const result = trimContextToBudget(ctx);

    expect(result.trimmed).toBe(true);
    expect(result.stepsApplied).toBe(5);

    // Assert all 5 trimming steps executed
    expect(result.context.checkout_summary.last_cart_value_minor).toBe(0);
    expect(result.context.invoice_summary.worst_days_overdue).toBe(0);
    expect(result.context.recovery_history.last_outcome).toBeNull();
    expect(result.context.payment_summary.last_success_at).toBeNull();
    expect(result.context.payment_summary.last_failure_at).toBeNull();
    expect(result.context.communication_history.reply_rate).toBe(0);

    // Assert Invariants are 100% preserved
    expect(result.context.customer.opted_out).toBe(true);
    expect(result.context.payment_summary.last_failure_code).toBe("insufficient_funds");
    expect(result.context.recovery_history.prior_cases).toBe(3);
    expect(result.context.recovery_history.recovered_cases).toBe(2);
    expect(result.context.recovery_history.stopped_cases).toBe(1);
    expect(result.context.communication_history.whatsapp_last_7d).toBe(2);
    expect(result.context.communication_history.email_last_14d).toBe(3);
    expect(result.context.communication_history.sms_last_7d).toBe(1);
  });
});
