import type { DomainEvent } from "@repo/domain";

/**
 * Standard event bus topics (Spec 01 §0, s-11 §Requirements 2).
 */
export const TOPIC_MAIN = "revenue-events.v1" as const;
export const TOPIC_RETRY = "revenue-events.retry" as const;
export const TOPIC_DLQ = "revenue-events.dlq" as const;

export const ALL_TOPICS = [TOPIC_MAIN, TOPIC_RETRY, TOPIC_DLQ] as const;
export type TopicName = (typeof ALL_TOPICS)[number] | (string & {});

/**
 * Standard consumer group roles (Spec 01 §0, s-11 §Requirements 2).
 */
export const GROUP_RISK_ENGINE = "risk-engine" as const;
export const GROUP_ORCHESTRATOR = "orchestrator" as const;
export const GROUP_ANALYTICS = "analytics" as const;

export type ConsumerGroupName =
  | typeof GROUP_RISK_ENGINE
  | typeof GROUP_ORCHESTRATOR
  | typeof GROUP_ANALYTICS
  | (string & {});

/**
 * Standard headers propagated across message envelopes (s-11 §Semantics).
 */
export interface BusMessageHeaders {
  [key: string]: string | undefined;
  "x-attempt"?: string;
  "x-first-seen"?: string;
  "x-last-error"?: string;
  "x-original-topic"?: string;
  "x-delay-until"?: string;
  "x-correlation-id"?: string;
  "traceparent"?: string;
  "tracestate"?: string;
}

/**
 * Context passed to event handler during processing.
 */
export interface EventContext {
  readonly topic: string;
  readonly group: string;
  readonly attempt: number;
  readonly firstSeenAt: string;
  readonly headers: BusMessageHeaders;
  readonly correlationId?: string;
}

export interface PublishOptions {
  topic?: string;
  key?: string; // partition key: defaults to event.tenant_id
  headers?: BusMessageHeaders;
}

export type EventHandler = (
  event: DomainEvent,
  context: EventContext,
) => Promise<void>;

export interface SubscribeOptions {
  autoCommit?: boolean;
  fromBeginning?: boolean;
}

/**
 * Standard Dead-Letter Queue (DLQ) message payload shape (s-11 §Semantics).
 */
export interface DlqMessage {
  originalEnvelope: unknown;
  error: {
    code: string;
    message: string;
    stack?: string;
  };
  attempts: number;
  firstTopic: string;
  failedAt: string;
}

/**
 * Common EventBus interface across both Redpanda and In-Process drivers (ADR-006, s-10, s-11).
 */
export interface EventBus {
  publish(event: DomainEvent, opts?: PublishOptions): Promise<void>;
  publishRaw?(
    topic: string,
    key: string | null,
    value: string,
    headers?: BusMessageHeaders,
  ): Promise<void>;
  subscribe(
    topic: string,
    group: string,
    handler: EventHandler,
    opts?: SubscribeOptions,
  ): Promise<void> | void;
  close(): Promise<void>;
}

export interface EventBusConfig {
  driver: "redpanda" | "inprocess";
  brokers?: string | null;
}

/**
 * NullBus stub for tests where an active broker is not needed.
 * Captures published events in memory for assertions.
 */
export class NullBus implements EventBus {
  private readonly _published: DomainEvent[] = [];
  private readonly _handlers: Map<string, EventHandler[]> = new Map();

  async publish(event: DomainEvent, opts?: PublishOptions): Promise<void> {
    this._published.push(event);
    const topic = opts?.topic ?? TOPIC_MAIN;
    const handlers = this._handlers.get(topic) ?? [];
    const ctx: EventContext = {
      topic,
      group: "null-bus",
      attempt: 1,
      firstSeenAt: new Date().toISOString(),
      headers: opts?.headers ?? {},
      correlationId: event.correlation_id,
    };
    for (const h of handlers) {
      await h(event, ctx).catch(() => {});
    }
  }

  async publishRaw(
    _topic: string,
    _key: string | null,
    _value: string,
    _headers?: BusMessageHeaders,
  ): Promise<void> {
    // no-op for raw publish in null bus
  }

  subscribe(
    topic: string,
    _group: string,
    handler: EventHandler,
    _opts?: SubscribeOptions,
  ): void {
    const list = this._handlers.get(topic) ?? [];
    list.push(handler);
    this._handlers.set(topic, list);
  }

  get published(): readonly DomainEvent[] {
    return this._published;
  }

  clearPublished(): void {
    this._published.length = 0;
  }

  clear(): void {
    this._published.length = 0;
    this._handlers.clear();
  }

  async close(): Promise<void> {
    this.clear();
  }
}

import { InProcessEventBus } from "./inprocess.bus";
import { RedpandaEventBus } from "./redpanda.bus";

/**
 * Factory function to create an EventBus instance based on driver configuration.
 */
export function createEventBus(config: EventBusConfig): EventBus {
  if (config.driver === "redpanda") {
    return new RedpandaEventBus({
      brokers: config.brokers ?? "localhost:9092",
    });
  }

  return new InProcessEventBus();
}
