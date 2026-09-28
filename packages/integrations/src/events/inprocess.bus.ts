import type { DomainEvent } from "@repo/domain";
import { recordBusPublished } from "@repo/observability";
import {
  TOPIC_MAIN,
  TOPIC_RETRY,
  TOPIC_DLQ,
  type BusMessageHeaders,
  type DlqMessage,
  type EventBus,
  type EventHandler,
  type PublishOptions,
  type SubscribeOptions,
} from "./event-bus";
import { encodeDomainEvent } from "./envelope-codec";
import { processConsumerMessage } from "./consumer";

interface InProcessSubscription {
  topic: string;
  group: string;
  handler: EventHandler;
  opts?: SubscribeOptions;
}

interface QueuedItem {
  topic: string;
  key: string;
  value: string;
  headers: BusMessageHeaders;
}

/**
 * In-process implementation of EventBus with identical semantics to Redpanda (s-11).
 * Features in-memory FIFO queues, per-tenant sequential delivery, delayed retry queue, and DLQ capture.
 */
export class InProcessEventBus implements EventBus {
  private readonly subscriptions: Map<string, InProcessSubscription[]> =
    new Map();
  private readonly published: QueuedItem[] = [];
  private readonly dlq: DlqMessage[] = [];
  private readonly activeTimers: Set<ReturnType<typeof setTimeout>> = new Set();
  private readonly inFlightPromises: Set<Promise<void>> = new Set();
  private readonly tenantChains: Map<string, Promise<void>> = new Map();
  private isClosed = false;
  // Set at close() start: stops scheduling NEW delayed retries (they would
  // stall drain on backoff timers) while in-flight work finishes. DLQ writes
  // are immediate and always allowed through.
  private isClosing = false;

  async publish(event: DomainEvent, opts?: PublishOptions): Promise<void> {
    if (this.isClosed) {
      throw new Error("Cannot publish to closed InProcessEventBus");
    }

    const topic = opts?.topic ?? TOPIC_MAIN;
    const key = opts?.key ?? event.tenant_id;
    const rawHeaders: BusMessageHeaders = {
      ...(opts?.headers ?? {}),
      "x-correlation-id": event.correlation_id,
      traceparent: event.traceparent,
    };

    const value = encodeDomainEvent(event);
    const item: QueuedItem = { topic, key, value, headers: rawHeaders };
    this.published.push(item);
    recordBusPublished(topic);

    await this.dispatchToSubscriptions(item);
  }

  async publishRaw(
    topic: string,
    key: string | null,
    value: string,
    headers?: BusMessageHeaders,
  ): Promise<void> {
    if (this.isClosed) {
      throw new Error("Cannot publish to closed InProcessEventBus");
    }

    const effectiveKey = key ?? "global";
    const item: QueuedItem = {
      topic,
      key: effectiveKey,
      value,
      headers: headers ?? {},
    };
    this.published.push(item);
    recordBusPublished(topic);

    await this.dispatchToSubscriptions(item);
  }

  subscribe(
    topic: string,
    group: string,
    handler: EventHandler,
    opts?: SubscribeOptions,
  ): void {
    if (this.isClosed) {
      throw new Error("Cannot subscribe to closed InProcessEventBus");
    }

    const list = this.subscriptions.get(topic) ?? [];
    list.push({ topic, group, handler, opts });
    this.subscriptions.set(topic, list);
  }

  private async dispatchToSubscriptions(item: QueuedItem): Promise<void> {
    const subs = this.subscriptions.get(item.topic) ?? [];
    if (subs.length === 0) {
      return;
    }

    for (const sub of subs) {
      if (item.topic === TOPIC_RETRY && item.headers["x-delay-until"]) {
        // Delayed processing for retry queue. Dropped once closing: close()
        // already cleared pending retry timers, and scheduling new backoff
        // timers during drain would stall teardown (same drop semantics).
        if (this.isClosing || this.isClosed) {
          return;
        }
        const delayUntilMs = new Date(item.headers["x-delay-until"]).getTime();
        const delayMs = Math.max(0, delayUntilMs - Date.now());

        const timerPromise = new Promise<void>((resolve) => {
          const timer = setTimeout(async () => {
            this.activeTimers.delete(timer);
            if (!this.isClosed) {
              await this.enqueuePerTenant(sub, item);
            }
            resolve();
          }, delayMs);
          this.activeTimers.add(timer);
        });

        this.trackInFlight(timerPromise);
      } else {
        const p = this.enqueuePerTenant(sub, item);
        this.trackInFlight(p);
      }
    }
  }

  /**
   * Guarantees strict sequential (FIFO) processing per tenant for a given consumer group.
   */
  private async enqueuePerTenant(
    sub: InProcessSubscription,
    item: QueuedItem,
  ): Promise<void> {
    const chainKey = `${sub.group}:${item.key}`;
    const previous = this.tenantChains.get(chainKey) ?? Promise.resolve();

    const current = previous
      .catch(() => {})
      .then(async () => {
        if (this.isClosed) return;
        await this.executeConsumer(sub, item);
      });

    this.tenantChains.set(chainKey, current);
    await current;
  }

  private async executeConsumer(
    sub: InProcessSubscription,
    item: QueuedItem,
  ): Promise<void> {
    await processConsumerMessage({
      topic: item.topic,
      group: sub.group,
      key: item.key,
      value: item.value,
      headers: item.headers,
      handler: sub.handler,
      handlerTimeoutMs: sub.opts?.handlerTimeoutMs,
      publishToRetry: async (event, retryHeaders) => {
        try {
          await this.publish(event, {
            topic: TOPIC_RETRY,
            key: item.key,
            headers: retryHeaders,
          });
        } catch (err) {
          // Teardown race: close() landed mid-flight. The retry is dropped
          // (same as a cleared retry timer); anything else still throws.
          if (!this.isClosed) throw err;
        }
      },
      publishToDlq: async (dlqMsg, dlqHeaders) => {
        // Authoritative record is the in-memory DLQ; the DLQ-topic fan-out
        // below is best-effort observability.
        this.dlq.push(dlqMsg);
        try {
          await this.publishRaw(
            TOPIC_DLQ,
            item.key,
            JSON.stringify(dlqMsg),
            dlqHeaders,
          );
        } catch (err) {
          // Teardown race: record above is kept, fan-out dropped.
          if (!this.isClosed) throw err;
        }
      },
      commit: async () => {
        // In-process manual offset commit acknowledged
      },
    });
  }

  private trackInFlight(promise: Promise<void>): void {
    this.inFlightPromises.add(promise);
    promise.finally(() => {
      this.inFlightPromises.delete(promise);
    });
  }

  /**
   * Awaits all currently queued and in-flight operations across all groups.
   */
  async drain(): Promise<void> {
    // Wait for all in-flight promises
    while (this.inFlightPromises.size > 0) {
      await Promise.all(Array.from(this.inFlightPromises));
    }
    // Wait for all tenant chains
    const chains = Array.from(this.tenantChains.values());
    await Promise.all(chains);
  }

  getDlqMessages(): readonly DlqMessage[] {
    return [...this.dlq];
  }

  getPublishedItems(): readonly QueuedItem[] {
    return [...this.published];
  }

  clear(): void {
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.published.length = 0;
    this.dlq.length = 0;
    this.subscriptions.clear();
    this.tenantChains.clear();
    this.inFlightPromises.clear();
    this.isClosing = false;
  }

  async close(): Promise<void> {
    // Clear delayed-retry timers first (their retries are dropped, same as
    // before), then let in-flight consumers finish their retry/DLQ fan-out
    // BEFORE marking closed — otherwise an in-flight DLQ/retry publish throws
    // "Cannot publish to closed InProcessEventBus" as an unhandled rejection
    // during teardown (e2e checkout suite). isClosing stops NEW backoff
    // timers from being scheduled mid-drain so close() can't stall.
    // External publishes after this point still throw via the isClosed gate.
    this.isClosing = true;
    for (const timer of this.activeTimers) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    await this.drain();
    this.isClosed = true;
  }
}
