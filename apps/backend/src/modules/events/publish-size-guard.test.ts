import { describe, it, expect } from "vitest";
import { mapEventPublishError } from "./routes";
import { ValidationError } from "../../lib/errors";
import {
  encodeDomainEvent,
  MAX_EVENT_PAYLOAD_BYTES,
} from "@repo/integrations";
import type { DomainEvent } from "@repo/domain";

/**
 * s-11 MED fix: oversized POST /events envelopes (256KB) must surface as
 * 422 VALIDATION, not 500 INTERNAL.
 *
 * envelope-codec throws a generic Error from encodeDomainEvent; the route
 * translates it via mapEventPublishError (awaited publish behavior unchanged).
 * NullBus never encodes, so this DB-free unit pins the translation predicate
 * against the real codec message instead of spinning the full app.
 */
describe("s-11 POST /events 256KB size guard mapping", () => {
  const baseEvent: DomainEvent = {
    id: "00000000-0000-0000-0000-000000000001",
    type: "payment.failed",
    occurred_at: new Date().toISOString(),
    source: "INTERNAL",
    tenant_id: "00000000-0000-0000-0000-000000000002",
    customer_id: "cus_test",
    entity_id: "pay_test",
    entity_type: "PAYMENT",
    payload: {},
    correlation_id: "corr_test",
  };

  it("maps the real codec oversize error to 422 VALIDATION", () => {
    const oversized = {
      ...baseEvent,
      payload: { blob: "x".repeat(MAX_EVENT_PAYLOAD_BYTES) },
    };
    let codecError: unknown;
    try {
      encodeDomainEvent(oversized);
    } catch (err) {
      codecError = err;
    }
    expect(codecError).toBeInstanceOf(Error);

    const mapped = mapEventPublishError(codecError);
    expect(mapped).toBeInstanceOf(ValidationError);
    const validation = mapped as ValidationError;
    expect(validation.code).toBe("VALIDATION");
    expect(validation.statusCode).toBe(422);
    expect(validation.message).toMatch(/256KB/);
  });

  it("passes ValidationErrors and non-size errors through unchanged", () => {
    const validation = new ValidationError("already mapped");
    expect(mapEventPublishError(validation)).toBe(validation);

    const transport = new Error("connection reset by peer");
    expect(mapEventPublishError(transport)).toBe(transport);
  });
});
