import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { Kafka } from "kafkajs";
import type { DomainEvent } from "@repo/domain";
import {
  TOPIC_MAIN,
  TOPIC_RETRY,
  TOPIC_DLQ,
  type DlqMessage,
} from "./event-bus";
import { RedpandaEventBus } from "./redpanda.bus";
import { RetryableError } from "./consumer";

// s-11 audit fix: opt-in live-broker roundtrip suite. Skipped unless
// REDPANDA_BROKERS is set (ADR-006: the broker is optional in dev/CI; the
// in-process parity suite in bus-parity.test.ts covers semantics by default).
// Run against the compose Redpanda, e.g.:
//   REDPANDA_BROKERS=localhost:9092 bunx vitest run redpanda-live
const brokers = (process.env.REDPANDA_BROKERS ?? "")
  .split(",")
  .map((b) => b.trim())
  .filter(Boolean);

const runId = randomUUID().slice(0, 8);

function createLiveEvent(overrides: Partial<DomainEvent> = {}): DomainEvent {
  const tenantId = overrides.tenant_id ?? `live-tenant-${runId}`;
  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "payment.failed",
    occurred_at: overrides.occurred_at ?? new Date().toISOString(),
    source: overrides.source ?? "STRIPE",
    tenant_id: tenantId,
    customer_id: overrides.customer_id ?? randomUUID(),
    entity_type: overrides.entity_type ?? "PAYMENT",
    entity_id: overrides.entity_id ?? randomUUID(),
    payload: overrides.payload ?? { amount: 5000, currency: "USD", live: true },
    correlation_id: overrides.correlation_id ?? randomUUID(),
    ...overrides,
  };
}

/** Polls `check` until it returns a non-null value or the deadline expires. */
async function waitFor<T>(
  check: () => T | null,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = check();
    if (last !== null) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

describe.skipIf(brokers.length === 0)(
  "Step 11 — Live Redpanda roundtrip (opt-in via REDPANDA_BROKERS)",
  { timeout: 90000 },
  () => {
    let bus: RedpandaEventBus;

    beforeAll(async () => {
      bus = new RedpandaEventBus({
        brokers,
        clientId: `live-test-${runId}`,
      });
      await bus.ensureTopics();
    });

    afterAll(async () => {
      await bus?.close();
    });

    it("publish -> subscribe roundtrip delivers the envelope with context metadata", async () => {
      const group = `live-roundtrip-${runId}`;
      const received: DomainEvent[] = [];
      const event = createLiveEvent();

      await bus.subscribe(TOPIC_MAIN, group, async (evt) => {
        if (evt.id === event.id) received.push(evt);
      });

      await bus.publish(event);

      const found = await waitFor(
        () => (received.length > 0 ? received[0]! : null),
        30000,
        "live roundtrip delivery",
      );
      expect(found.type).toBe("payment.failed");
      expect(found.tenant_id).toBe(event.tenant_id);
      expect(found.correlation_id).toBe(event.correlation_id);
    });

    it("persistent retryable failure cascades main -> retry -> DLQ with the standard DLQ shape", async () => {
      const group = `live-dlq-${runId}`;
      const retryGroup = `live-dlq-retry-${runId}`;
      const event = createLiveEvent();

      // Both main and retry consumers always fail retryably: attempt 1->2->3
      // ->4->5, then attempt 5 exhausts to the DLQ (MAX_RETRIES_EXCEEDED).
      // (The Redpanda driver honors x-delay-until backoff via pause + requeue
      // + resume, so the cascade takes backoff time rather than seconds —
      // small remainders are held inline, larger ones deferred without
      // starving the partition.)
      // NOTE: MAIN and RETRY use DISTINCT groups. Sharing one groupId across
      // two consumers with disjoint topics stalls the retry member (proven
      // live: same-group cascade never advances past attempt 1).
      const alwaysRetryable = async () => {
        throw new RetryableError("live transient downstream timeout");
      };
      await bus.subscribe(TOPIC_MAIN, group, alwaysRetryable);
      await bus.subscribe(TOPIC_RETRY, retryGroup, alwaysRetryable);

      await bus.publish(event);

      // Read the DLQ with a raw consumer and filter to this run's event, so
      // other traffic on the shared DLQ topic cannot flake the assertion.
      const kafka = new Kafka({
        clientId: `live-dlq-reader-${runId}`,
        brokers,
      });
      const reader = kafka.consumer({ groupId: `live-dlq-reader-${runId}` });
      const seen: DlqMessage[] = [];
      await reader.connect();
      await reader.subscribe({ topic: TOPIC_DLQ, fromBeginning: true });
      await reader.run({
        autoCommit: true,
        eachMessage: async ({ message }) => {
          try {
            const parsed = JSON.parse(
              message.value?.toString("utf8") ?? "null",
            ) as DlqMessage;
            if (
              (parsed.originalEnvelope as DomainEvent)?.id === event.id &&
              !seen.some(
                (m) =>
                  (m.originalEnvelope as DomainEvent)?.id === event.id,
              )
            ) {
              seen.push(parsed);
            }
          } catch {
            // Ignore non-JSON traffic on the shared topic.
          }
        },
      });

      try {
        const dlq = await waitFor(
          () => (seen.length > 0 ? seen[0]! : null),
          60000,
          "live DLQ arrival",
        );
        expect(dlq.error.code).toBe("MAX_RETRIES_EXCEEDED");
        expect(dlq.attempts).toBe(5);
        expect(dlq.firstTopic).toBe(TOPIC_MAIN);
        expect((dlq.originalEnvelope as DomainEvent).id).toBe(event.id);
      } finally {
        await reader.disconnect();
      }
    });
  },
);
