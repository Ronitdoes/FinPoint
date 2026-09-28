import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { inboundEventSchema } from "./routes";

/**
 * s-11 gaps: per-type `payload` validation for POST /events.
 *
 * Previously the contract validated the envelope only (type, tenant_id,
 * entity_type/entity_id, occurred_at, source) while `payload` was
 * `z.record(z.unknown())` — any JSON object passed. Per-type schemas have
 * now landed in `inboundEventSchema` (see `routes.ts`):
 * payment.* / invoice.* require an amount-like field, checkout.* require a
 * cart value, subscription.* require a subscription anchor; known money /
 * date keys are type-checked whenever present.
 *
 * TODO(s-11): extend required-field coverage to customer.* money fields
 * (e.g. customer_payment_received amount) once real producer shapes are
 * confirmed; those families currently get type-checks-only validation.
 */
describe("s-11 per-type payload validation", () => {
  const baseEnvelope = {
    type: "payment.failed",
    tenant_id: randomUUID(),
    entity_type: "PAYMENT",
    entity_id: `pay_${randomUUID()}`,
  } as const;

  it("accepts payment.failed with an amount-like field", () => {
    for (const payload of [
      { amount: 5000, reason: "card_declined" },
      { amount_minor: 5000, currency: "USD" },
      { amount: 0 },
    ]) {
      const result = inboundEventSchema.safeParse({
        ...baseEnvelope,
        payload,
      });
      expect(
        result.success,
        `valid payload ${JSON.stringify(payload)} should pass`,
      ).toBe(true);
    }
  });

  it("rejects payment.failed without an amount (empty or unrelated payload)", () => {
    for (const payload of [
      {},
      { totally_unrelated: ["nested", { deep: 123 }], extra: null },
      { reason: "card_declined" },
    ]) {
      const result = inboundEventSchema.safeParse({
        ...baseEnvelope,
        payload,
      });
      expect(
        result.success,
        `payload ${JSON.stringify(payload)} must fail per-type validation`,
      ).toBe(false);
    }
  });

  it("rejects wrong types for known payload fields", () => {
    const result = inboundEventSchema.safeParse({
      ...baseEnvelope,
      payload: { amount: "not-a-number", currency: 12345 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invoice.overdue without an amount, accepts it with one", () => {
    const envelope = { ...baseEnvelope, type: "invoice.overdue" } as const;
    expect(
      inboundEventSchema.safeParse({ ...envelope, payload: {} }).success,
    ).toBe(false);
    expect(
      inboundEventSchema.safeParse({
        ...envelope,
        payload: { amount: 12000, currency: "USD" },
      }).success,
    ).toBe(true);
  });

  it("rejects checkout.started without a cart value, accepts known producer shapes", () => {
    const envelope = { ...baseEnvelope, type: "checkout.started" } as const;
    expect(
      inboundEventSchema.safeParse({ ...envelope, payload: {} }).success,
    ).toBe(false);
    // events.test.ts shape, normalizer shape, demo simulator shape.
    for (const payload of [
      { cart_total: 12000, currency: "USD" },
      { cart_value: 12000, currency: "USD" },
      { cartValue: 12000, currency: "INR" },
    ]) {
      expect(
        inboundEventSchema.safeParse({ ...envelope, payload }).success,
      ).toBe(true);
    }
  });

  it("rejects subscription.created without an anchor, accepts it with one", () => {
    const envelope = {
      ...baseEnvelope,
      type: "subscription.created",
    } as const;
    expect(
      inboundEventSchema.safeParse({ ...envelope, payload: {} }).success,
    ).toBe(false);
    expect(
      inboundEventSchema.safeParse({
        ...envelope,
        payload: { provider_subscription_id: "sub_123", status: "ACTIVE" },
      }).success,
    ).toBe(true);
  });

  it("still rejects unknown event types at the envelope boundary", () => {
    const result = inboundEventSchema.safeParse({
      ...baseEnvelope,
      type: "invalid.nonexistent.event.type",
      payload: {},
    });
    expect(result.success).toBe(false);
  });

  it("keeps envelope-only validation for other families (UNMAPPED, risk.*, case.*)", () => {
    for (const type of ["UNMAPPED", "risk.calculated", "case.opened"] as const) {
      const result = inboundEventSchema.safeParse({
        ...baseEnvelope,
        type,
        payload: {},
      });
      expect(result.success, `${type} with {} should still pass`).toBe(true);
    }
  });
});
