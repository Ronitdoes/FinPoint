import { describe, it, expect, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@repo/domain";
import { resetMetrics } from "@repo/observability";
import {
  TOPIC_MAIN,
  TOPIC_RETRY,
  TOPIC_DLQ,
  GROUP_RISK_ENGINE,
  GROUP_ORCHESTRATOR,
  type DlqMessage,
  type EventContext,
} from "./event-bus";
import {
  encodeDomainEvent,
  decodeDomainEvent,
  MAX_EVENT_PAYLOAD_BYTES,
} from "./envelope-codec";
import {
  isRetryableError,
  calculateBackoffMs,
  RetryableError,
  NonRetryableError,
  MAX_RETRY_ATTEMPTS,
} from "./consumer";
import { InProcessEventBus } from "./inprocess.bus";
import { RedpandaEventBus } from "./redpanda.bus";

function createValidEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  const tenantId = overrides.tenant_id ?? randomUUID();
  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "payment.failed",
    occurred_at: overrides.occurred_at ?? new Date().toISOString(),
    source: overrides.source ?? "STRIPE",
    tenant_id: tenantId,
    customer_id: overrides.customer_id ?? randomUUID(),
    entity_type: overrides.entity_type ?? "PAYMENT",
    entity_id: overrides.entity_id ?? randomUUID(),
    payload: overrides.payload ?? { amount: 5000, currency: "USD", reason: "insufficient_funds" },
    correlation_id: overrides.correlation_id ?? randomUUID(),
    traceparent: overrides.traceparent ?? "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    ...overrides,
  };
}

describe("Step 11 — Envelope Codec & Poison Pill Handling", () => {
  it("encodes a valid DomainEvent to JSON string", () => {
    const event = createValidEvent();
    const encoded = encodeDomainEvent(event);
    expect(typeof encoded).toBe("string");
    const parsed = JSON.parse(encoded);
    expect(parsed.id).toBe(event.id);
    expect(parsed.type).toBe("payment.failed");
  });

  it("rejects event payload exceeding MAX_EVENT_PAYLOAD_BYTES (256KB)", () => {
    const largeString = "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 100);
    const event = createValidEvent({
      payload: { large: largeString },
    });
    expect(() => encodeDomainEvent(event)).toThrow(/exceeds maximum allowed size/i);
  });

  it("decodes valid JSON string into a DomainEvent", () => {
    const event = createValidEvent();
    const encoded = encodeDomainEvent(event);
    const result = decodeDomainEvent(encoded);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.event.id).toBe(event.id);
      expect(result.event.tenant_id).toBe(event.tenant_id);
    }
  });

  it("detects malformed JSON string as a poison pill", () => {
    const malformed = "{ this is not json }";
    const result = decodeDomainEvent(malformed);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.isPoison).toBe(true);
      expect(result.error.message).toMatch(/Malformed JSON/i);
    }
  });

  it("detects schema-invalid payload as a poison pill (missing mandatory fields)", () => {
    const invalid = JSON.stringify({
      id: "123",
      type: "invalid.nonexistent.type",
    });
    const result = decodeDomainEvent(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.isPoison).toBe(true);
      expect(result.error.message).toMatch(/Schema validation failure/i);
    }
  });

  it("detects oversized payload on decode as a poison pill", () => {
    const largeText = "x".repeat(MAX_EVENT_PAYLOAD_BYTES + 50);
    const result = decodeDomainEvent(largeText);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.isPoison).toBe(true);
      expect(result.error.message).toMatch(/exceeds maximum allowed size/i);
    }
  });
});

describe("Step 11 — Error Classification & Exponential Backoff Engine", () => {
  it("classifies explicit RetryableError as retryable", () => {
    expect(isRetryableError(new RetryableError("temporary network blip"))).toBe(true);
  });

  it("classifies explicit NonRetryableError as non-retryable", () => {
    expect(isRetryableError(new NonRetryableError("permanent business violation"))).toBe(false);
  });

  it("classifies network errors and timeouts as retryable", () => {
    const netErr = new Error("Connection reset by peer");
    (netErr as any).code = "ECONNRESET";
    expect(isRetryableError(netErr)).toBe(true);

    const timeoutErr = new Error("Request timed out");
    (timeoutErr as any).name = "TimeoutError";
    expect(isRetryableError(timeoutErr)).toBe(true);
  });

  it("classifies PostgreSQL serialization failure (40001) and deadlock (40P01) as retryable", () => {
    const dbErr1 = new Error("could not serialize access due to concurrent update");
    (dbErr1 as any).code = "40001";
    expect(isRetryableError(dbErr1)).toBe(true);

    const dbErr2 = new Error("deadlock detected");
    (dbErr2 as any).code = "40P01";
    expect(isRetryableError(dbErr2)).toBe(true);
  });

  it("classifies HTTP 5xx errors as retryable and 4xx errors as non-retryable", () => {
    const err503 = new Error("Service Unavailable");
    (err503 as any).statusCode = 503;
    expect(isRetryableError(err503)).toBe(true);

    const err400 = new Error("Bad Request");
    (err400 as any).statusCode = 400;
    expect(isRetryableError(err400)).toBe(false);

    const err422 = new Error("Validation Error");
    (err422 as any).statusCode = 422;
    expect(isRetryableError(err422)).toBe(false);
  });

  it("calculates exponential backoff with full jitter bounded by cap", () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const delay = calculateBackoffMs(attempt, 1000, 2, 60000);
      const maxCap = Math.min(60000, 1000 * Math.pow(2, attempt - 1));
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(maxCap);
    }
  });
});

describe("Step 11 — Driver Parity: InProcessEventBus", () => {
  let bus: InProcessEventBus;

  beforeEach(() => {
    resetMetrics();
    bus = new InProcessEventBus();
  });

  it("Scenario 1: Happy path publish -> consume roundtrip with context metadata", async () => {
    const received: { event: DomainEvent; ctx: EventContext }[] = [];
    const event = createValidEvent({ type: "checkout.started" });

    bus.subscribe(TOPIC_MAIN, GROUP_RISK_ENGINE, async (evt, ctx) => {
      received.push({ event: evt, ctx });
    });

    await bus.publish(event);
    await bus.drain();

    expect(received.length).toBe(1);
    const rec = received[0]!;
    expect(rec.event.id).toBe(event.id);
    expect(rec.event.type).toBe("checkout.started");
    expect(rec.ctx.topic).toBe(TOPIC_MAIN);
    expect(rec.ctx.group).toBe(GROUP_RISK_ENGINE);
    expect(rec.ctx.attempt).toBe(1);
    expect(rec.ctx.correlationId).toBe(event.correlation_id);
  });

  it("Scenario 2: Preserves strict sequential FIFO delivery per tenant within consumer group", async () => {
    const tenantId = `tenant-${randomUUID()}`;
    const executionOrder: number[] = [];

    bus.subscribe(TOPIC_MAIN, GROUP_ORCHESTRATOR, async (evt) => {
      // Simulate random latency to test concurrency lock
      await new Promise((r) => setTimeout(r, Math.random() * 10));
      executionOrder.push(Number(evt.payload.seq));
    });

    for (let i = 1; i <= 5; i++) {
      await bus.publish(
        createValidEvent({
          tenant_id: tenantId,
          payload: { seq: i },
        }),
      );
    }

    await bus.drain();
    expect(executionOrder).toEqual([1, 2, 3, 4, 5]);
  });

  it("Scenario 3: Retryable error triggers retry topic re-enqueuing with attempt metadata", async () => {
    const retryEvents: { event: DomainEvent; ctx: EventContext }[] = [];
    let callCount = 0;

    bus.subscribe(TOPIC_MAIN, GROUP_RISK_ENGINE, async () => {
      callCount++;
      throw new RetryableError("transient database connection failure");
    });

    bus.subscribe(TOPIC_RETRY, GROUP_RISK_ENGINE, async (evt, ctx) => {
      retryEvents.push({ event: evt, ctx });
    });

    const event = createValidEvent();
    await bus.publish(event);
    await bus.drain();

    expect(callCount).toBe(1);
    expect(retryEvents.length).toBe(1);
    const ret = retryEvents[0]!;
    expect(ret.ctx.attempt).toBe(2);
    expect(ret.ctx.headers["x-attempt"]).toBe("2");
    expect(ret.ctx.headers["x-last-error"]).toMatch(/transient database connection failure/);
    expect(ret.ctx.headers["x-original-topic"]).toBe(TOPIC_MAIN);
    expect(ret.ctx.headers["x-delay-until"]).toBeDefined();
  });

  it("Scenario 4: Non-retryable error routes straight to DLQ with error metadata", async () => {
    bus.subscribe(TOPIC_MAIN, GROUP_RISK_ENGINE, async () => {
      throw new NonRetryableError("customer blocked by compliance sanctions");
    });

    const event = createValidEvent();
    await bus.publish(event);
    await bus.drain();

    const dlqMessages = bus.getDlqMessages();
    expect(dlqMessages.length).toBe(1);
    const dlq = dlqMessages[0]!;
    expect(dlq.error.message).toMatch(/compliance sanctions/);
    expect(dlq.firstTopic).toBe(TOPIC_MAIN);
    expect(dlq.attempts).toBe(1);
    expect((dlq.originalEnvelope as DomainEvent).id).toBe(event.id);
  });

  it("Scenario 5: Retryable error exceeding MAX_RETRY_ATTEMPTS (5) routes to DLQ", async () => {
    bus.subscribe(TOPIC_RETRY, GROUP_RISK_ENGINE, async () => {
      throw new RetryableError("persistent downstream timeout");
    });

    const event = createValidEvent();
    // Publish with attempt count already at 5
    await bus.publish(event, {
      topic: TOPIC_RETRY,
      headers: {
        "x-attempt": "5",
        "x-first-seen": new Date().toISOString(),
        "x-original-topic": TOPIC_MAIN,
      },
    });

    await bus.drain();

    const dlqMessages = bus.getDlqMessages();
    expect(dlqMessages.length).toBe(1);
    const dlq = dlqMessages[0]!;
    expect(dlq.attempts).toBe(5);
    expect(dlq.error.code).toBe("MAX_RETRIES_EXCEEDED");
  });

  it("Scenario 6: Poison message (corrupted JSON) routes immediately to DLQ without retry", async () => {
    let handlerInvoked = false;
    bus.subscribe(TOPIC_MAIN, GROUP_RISK_ENGINE, async () => {
      handlerInvoked = true;
    });

    await bus.publishRaw(
      TOPIC_MAIN,
      "tenant-1",
      "{ invalid json payload syntax !!!",
    );

    await bus.drain();

    expect(handlerInvoked).toBe(false);
    const dlqMessages = bus.getDlqMessages();
    expect(dlqMessages.length).toBe(1);
    const dlq = dlqMessages[0]!;
    expect(dlq.error.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(dlq.error.message).toMatch(/Malformed JSON/);
  });

  it("Scenario 7: Clean graceful shutdown drains in-flight handlers and rejects new publishes", async () => {
    let completed = false;

    bus.subscribe(TOPIC_MAIN, GROUP_RISK_ENGINE, async () => {
      await new Promise((r) => setTimeout(r, 20));
      completed = true;
    });

    const event = createValidEvent();
    await bus.publish(event);

    await bus.close();
    expect(completed).toBe(true);

    // After close, publishing throws
    await expect(bus.publish(createValidEvent())).rejects.toThrow(/closed/);
  });
});

describe("Step 11 — Driver Parity: RedpandaEventBus Structure & Semantics", () => {
  it("instantiates RedpandaEventBus with configured brokers and exports interface", () => {
    const bus = new RedpandaEventBus({
      brokers: ["localhost:9092"],
      clientId: "test-client",
      autoCreateTopics: false,
    });
    expect(bus).toBeDefined();
    expect(typeof bus.publish).toBe("function");
    expect(typeof bus.subscribe).toBe("function");
    expect(typeof bus.close).toBe("function");
  });

  it("handles graceful shutdown without open connections", async () => {
    const bus = new RedpandaEventBus({
      brokers: ["localhost:9092"],
      autoCreateTopics: false,
    });
    await expect(bus.close()).resolves.toBeUndefined();
    await expect(bus.publish(createValidEvent())).rejects.toThrow(/closed/);
  });
});
