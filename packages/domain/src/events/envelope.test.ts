import { describe, expect, it } from "vitest";

import {
  domainEventSchema,
  parseDomainEvent,
} from "./envelope";

function validEvent(): Record<string, unknown> {
  return {
    id: "evt_uuid",
    type: "payment.failed",
    occurred_at: "2026-08-23T10:30:00Z",
    source: "razorpay",
    tenant_id: "tenant_123",
    customer_id: "cus_123",
    entity_id: "pay_123",
    entity_type: "PAYMENT",
    payload: {},
    correlation_id: "7f9c24e4-5b1a-4a1e-9c3f-8f2a7ff1d001",
  };
}

const ACTIONABLE_FIELDS = [
  "id",
  "type",
  "occurred_at",
  "source",
  "tenant_id",
  "customer_id",
  "entity_id",
  "entity_type",
  "payload",
  "correlation_id",
] as const;

describe("domainEventSchema", () => {
  it("accepts the canonical envelope from spec 01 §6", () => {
    const parsed = parseDomainEvent(validEvent());
    expect(parsed.type).toBe("payment.failed");
    expect(parsed.entity_type).toBe("PAYMENT");
    expect(parsed.payload).toEqual({});
  });

  it.each(ACTIONABLE_FIELDS)("rejects when %s is missing", (field) => {
    const event = validEvent();
    delete event[field];
    expect(domainEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects event types outside the taxonomy", () => {
    const event = { ...validEvent(), type: "payment.exploded" };
    expect(domainEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects every taxonomy string not in spec order-sensitive casing", () => {
    const event = { ...validEvent(), type: "Payment.Failed" };
    expect(domainEventSchema.safeParse(event).success).toBe(false);
  });

  it.each([
    "2026-08-23 10:30:00",
    "not-a-date",
    "2026-13-01T00:00:00Z",
    "1760000000",
  ])("rejects bad occurred_at %s", (occurredAt) => {
    const event = { ...validEvent(), occurred_at: occurredAt };
    expect(domainEventSchema.safeParse(event).success).toBe(false);
  });

  it.each([
    { id: "" },
    { source: "" },
    { tenant_id: "" },
    { customer_id: "" },
    { entity_id: "" },
    { correlation_id: "" },
  ])("rejects empty ids (%s)", (override) => {
    const event = { ...validEvent(), ...override };
    expect(domainEventSchema.safeParse(event).success).toBe(false);
  });

  it("rejects payload that is not an object", () => {
    const event = { ...validEvent(), payload: [1, 2] };
    const result = domainEventSchema.safeParse(event);
    expect(result.success).toBe(false);
    const arrayPayload = { ...validEvent(), payload: "nope" };
    expect(domainEventSchema.safeParse(arrayPayload).success).toBe(false);
  });

  it("accepts optional traceparent and structured payloads", () => {
    const parsed = parseDomainEvent({
      ...validEvent(),
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      payload: { attempt: 1, amount_minor: 250000 },
    });
    expect(parsed.payload).toEqual({ attempt: 1, amount_minor: 250000 });
  });

  it("rejects unknown top-level fields (closed envelope)", () => {
    const event = { ...validEvent(), extra: true };
    expect(domainEventSchema.safeParse(event).success).toBe(false);
  });

  it("accepts offset datetime strings", () => {
    const event = { ...validEvent(), occurred_at: "2026-08-23T16:00:00+05:30" };
    expect(domainEventSchema.safeParse(event).success).toBe(true);
  });
});
