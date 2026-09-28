import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@repo/domain";
import {
  TOPIC_MAIN,
  TOPIC_RETRY,
  GROUP_RISK_ENGINE,
  type BusMessageHeaders,
  type DlqMessage,
} from "./event-bus";
import { encodeDomainEvent } from "./envelope-codec";
import {
  HANDLER_TIMEOUT_MS,
  RetryableError,
  isRetryableError,
  processConsumerMessage,
} from "./consumer";
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

const hungHandler = () => new Promise<void>(() => {});

describe("s-11 gaps — consumer handler timeout", () => {
  it("exposes a 30s default handler timeout", () => {
    expect(HANDLER_TIMEOUT_MS).toBe(30000);
  });

  it("hung handler yields a RETRYABLE timeout (retry path) instead of hanging", async () => {
    let retried = 0;
    let dlq = 0;
    let committed = 0;
    let lastRetryHeaders: BusMessageHeaders = {};

    const start = Date.now();
    await processConsumerMessage({
      topic: TOPIC_MAIN,
      group: GROUP_RISK_ENGINE,
      key: "tenant-1",
      value: encodeDomainEvent(createEvent()),
      headers: {},
      handler: hungHandler,
      publishToRetry: async (_event, headers) => {
        retried++;
        lastRetryHeaders = headers;
      },
      publishToDlq: async () => {
        dlq++;
      },
      commit: async () => {
        committed++;
      },
      handlerTimeoutMs: 50,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(5000);
    expect(retried).toBe(1);
    expect(dlq).toBe(0);
    expect(committed).toBe(1);
    expect(lastRetryHeaders["x-attempt"]).toBe("2");
    expect(String(lastRetryHeaders["x-last-error"])).toMatch(/timed out/);
  });

  it("timeout error itself classifies RETRYABLE", () => {
    const err = new RetryableError("Event handler timed out after 50ms");
    expect(isRetryableError(err)).toBe(true);
  });

  it("hung handler at max attempts routes to DLQ instead of hanging", async () => {
    let dlq: DlqMessage[] = [];

    await processConsumerMessage({
      topic: TOPIC_MAIN,
      group: GROUP_RISK_ENGINE,
      key: "tenant-1",
      value: encodeDomainEvent(createEvent()),
      headers: {
        "x-attempt": "5",
        "x-first-seen": new Date().toISOString(),
        "x-original-topic": TOPIC_MAIN,
      },
      handler: hungHandler,
      publishToRetry: async () => {
        throw new Error("must not retry past max attempts");
      },
      publishToDlq: async (msg) => {
        dlq.push(msg);
      },
      commit: async () => {},
      handlerTimeoutMs: 50,
    });

    expect(dlq.length).toBe(1);
    expect(dlq[0]!.error.message).toMatch(/timed out/);
    expect(dlq[0]!.attempts).toBe(5);
  });

  it("fast handler is unaffected by the timeout", async () => {
    let handled = false;
    let committed = 0;

    await processConsumerMessage({
      topic: TOPIC_MAIN,
      group: GROUP_RISK_ENGINE,
      key: "tenant-1",
      value: encodeDomainEvent(createEvent()),
      headers: {},
      handler: async () => {
        handled = true;
      },
      publishToRetry: async () => {
        throw new Error("must not retry a success");
      },
      publishToDlq: async () => {
        throw new Error("must not DLQ a success");
      },
      commit: async () => {
        committed++;
      },
      handlerTimeoutMs: 50,
    });

    expect(handled).toBe(true);
    expect(committed).toBe(1);
  });

  it("InProcess bus does not head-of-line block on a hung handler (per-tenant chain advances)", async () => {
    const bus = new InProcessEventBus();
    try {
      const seen: string[] = [];
      const retrySeen: string[] = [];
      const tenantId = randomUUID();

      const first = { ...createEvent(), tenant_id: tenantId };
      const second = { ...createEvent(), tenant_id: tenantId };

      bus.subscribe(
        TOPIC_MAIN,
        GROUP_RISK_ENGINE,
        async (evt) => {
          seen.push(evt.id);
          if (evt.id === first.id) {
            await new Promise<void>(() => {}); // hang forever on purpose
          }
        },
        { handlerTimeoutMs: 50 },
      );
      bus.subscribe(TOPIC_RETRY, GROUP_RISK_ENGINE, async (evt) => {
        retrySeen.push(evt.id);
      });

      // publish(first) itself must resolve via the timeout (not hang), then
      // the second same-tenant message must still be attempted.
      await bus.publish(first);
      await bus.publish(second);
      await bus.drain();

      expect(seen).toContain(first.id);
      expect(seen).toContain(second.id);
      expect(retrySeen).toContain(first.id);
    } finally {
      await bus.close();
    }
  });
});
