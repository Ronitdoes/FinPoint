/**
 * Chaos benchmark: backlog drain — 5k mixed events while the bus is down
 * (Step 31 §Requirements 5).
 *
 * The consumer is held behind a gate (bus-down analogue) while 5,000 mixed
 * events enqueue; the gate then opens (bus up) and the suite measures drain
 * time with zero loss and zero duplicates. A closed-bus publish is also
 * proven to fail fast per policy instead of silently dropping.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@repo/domain";
import { InProcessEventBus, TOPIC_MAIN } from "@repo/integrations";
import { recordBacklogDrain } from "@repo/observability";
import { drillStartRedpanda, drillStopRedpanda } from "../harness/compose-admin";
import { resetChaosHarness } from "../harness/fault-points";

const TOTAL = 5000;
const TYPES = [
  "payment.failed",
  "payment.succeeded",
  "checkout.abandoned",
  "invoice.overdue",
] as const;

function makeEvent(index: number): DomainEvent {
  const type = TYPES[index % TYPES.length];
  const entityType =
    type === "payment.failed" || type === "payment.succeeded"
      ? "PAYMENT"
      : type === "checkout.abandoned"
        ? "CHECKOUT"
        : "INVOICE";
  return {
    id: `chaos-drain-${index}-${randomUUID()}`,
    type,
    occurred_at: new Date().toISOString(),
    source: "STRIPE",
    tenant_id: `tenant-${index % 25}`,
    customer_id: `customer-${index % 500}`,
    entity_id: `entity-${index}`,
    entity_type: entityType,
    payload: { chaos: "backlog-drain", index },
    correlation_id: randomUUID(),
  };
}

describe("chaos: backlog drain benchmark", { timeout: 120000 }, () => {
  afterEach(() => {
    resetChaosHarness();
  });

  it("5k mixed events drain with zero loss and zero duplicates", async () => {
    const bus = new InProcessEventBus();
    const received: string[] = [];

    // Consumer is DOWN: gate closed, nothing drains yet.
    let gateOpen = false;
    const gateWaiters: Array<() => void> = [];
    bus.subscribe(TOPIC_MAIN, "chaos-drain", async (event) => {
      if (!gateOpen) {
        await new Promise<void>((resolve) => {
          gateWaiters.push(resolve);
        });
      }
      received.push(event.id);
    });

    // Enqueue the full backlog while the consumer is held (publish buffers +
    // kicks off dispatch without awaiting handlers, so this cannot deadlock).
    const events = Array.from({ length: TOTAL }, (_, i) => makeEvent(i));
    await Promise.all(events.map((event) => bus.publish(event)));

    // Let every handler reach the gate, then bring the bus up and time the drain.
    await new Promise((resolve) => setTimeout(resolve, 250));
    const startedAt = performance.now();
    gateOpen = true;
    for (const release of gateWaiters.splice(0)) release();

    await bus.drain();
    const drainMs = performance.now() - startedAt;
    recordBacklogDrain(TOPIC_MAIN, drainMs);

    expect(received.length).toBe(TOTAL);
    // Zero loss AND zero duplicates: the id set matches the published set.
    expect(new Set(received).size).toBe(TOTAL);
    expect(new Set(received)).toEqual(new Set(events.map((e) => e.id)));

    // Timing recorded for the evidence table (generous CI ceiling: 60s).
    expect(drainMs).toBeLessThan(60000);

    await bus.close();
  });

  it("publishing to a closed bus fails fast instead of silently dropping", async () => {
    const bus = new InProcessEventBus();
    await bus.close();
    await expect(bus.publish(makeEvent(0))).rejects.toThrow(/closed/);
  });

  it("redpanda kill drills are admin-guarded and skipped without CHAOS_INFRA", () => {
    expect(drillStopRedpanda().skipped).toBe(true);
    expect(drillStartRedpanda().skipped).toBe(true);
  });
});
