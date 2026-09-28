import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@repo/domain";
import { TOPIC_MAIN, GROUP_ORCHESTRATOR } from "./event-bus";
import { NonRetryableError, RetryableError } from "./consumer";
import { InProcessEventBus } from "./inprocess.bus";

function createEvent(): DomainEvent {
  const tenantId = randomUUID();
  return {
    id: randomUUID(),
    type: "payment.failed",
    occurred_at: new Date().toISOString(),
    source: "STRIPE",
    tenant_id: tenantId,
    customer_id: randomUUID(),
    entity_type: "PAYMENT",
    entity_id: randomUUID(),
    payload: { amount: 5000, currency: "USD" },
    correlation_id: randomUUID(),
  };
}

describe("InProcessEventBus close() teardown race", () => {
  it("close() during an in-flight DLQ write keeps the record and throws nothing", async () => {
    const bus = new InProcessEventBus();
    // Gate the handler so close() lands mid-flight deterministically.
    let releaseHandler!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    bus.subscribe(TOPIC_MAIN, GROUP_ORCHESTRATOR, async () => {
      await gate;
      throw new NonRetryableError("boom");
    });

    const publishPromise = bus.publish(createEvent());
    // Let dispatch reach the gated handler, then close mid-flight.
    await new Promise((r) => setTimeout(r, 50));
    releaseHandler();
    await bus.close();
    await publishPromise;

    // Authoritative in-memory DLQ record survived the teardown race.
    expect(bus.getDlqMessages()).toHaveLength(1);
    expect(bus.getDlqMessages()[0]?.error.message).toBe("boom");
  });

  it("close() resolves promptly with a pending retryable failure (no backoff stall)", async () => {
    const bus = new InProcessEventBus();
    let releaseHandler!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    bus.subscribe(TOPIC_MAIN, GROUP_ORCHESTRATOR, async () => {
      await gate;
      throw new RetryableError("flaky provider");
    });

    const publishPromise = bus.publish(createEvent());
    await new Promise((r) => setTimeout(r, 50));
    releaseHandler();
    const start = Date.now();
    await bus.close();
    await publishPromise;

    // Delayed retry dropped on teardown (timer semantics), close is fast —
    // well under the first backoff delay (~1s with jitter).
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("external publish after close() still throws (contract preserved)", async () => {
    const bus = new InProcessEventBus();
    await bus.close();
    await expect(bus.publish(createEvent())).rejects.toThrow(
      /closed InProcessEventBus/,
    );
  });
});
