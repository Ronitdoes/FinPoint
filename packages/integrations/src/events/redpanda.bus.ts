import {
  Kafka,
  type Producer,
  type Consumer,
  type Admin,
  type IHeaders,
  logLevel,
} from "kafkajs";
import type { DomainEvent } from "@repo/domain";
import { recordBusPublished } from "@repo/observability";
import {
  TOPIC_MAIN,
  TOPIC_RETRY,
  TOPIC_DLQ,
  ALL_TOPICS,
  type BusMessageHeaders,
  type DlqMessage,
  type EventBus,
  type EventHandler,
  type PublishOptions,
  type SubscribeOptions,
} from "./event-bus";
import { encodeDomainEvent } from "./envelope-codec";
import { processConsumerMessage } from "./consumer";

export interface RedpandaBusOptions {
  brokers?: string | string[];
  clientId?: string;
  autoCreateTopics?: boolean;
}

/**
 * Converts Record<string, string | undefined> to KafkaJS IHeaders (Record<string, Buffer | string>).
 */
function toKafkaHeaders(headers?: BusMessageHeaders): IHeaders {
  const result: IHeaders = {};
  if (!headers) return result;
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) {
      result[k] = v;
    }
  }
  return result;
}

/**
 * Converts KafkaJS headers to standard BusMessageHeaders.
 */
function fromKafkaHeaders(
  headers?: Record<string, Buffer | string | undefined>,
): BusMessageHeaders {
  const result: BusMessageHeaders = {};
  if (!headers) return result;
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) {
      result[k] = Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
    }
  }
  return result;
}

/**
 * Production-ready EventBus driver backed by Redpanda / Kafka (ADR-006, s-11).
 */
export class RedpandaEventBus implements EventBus {
  private readonly kafka: Kafka;
  private producer: Producer | null = null;
  private admin: Admin | null = null;
  private readonly consumers: Consumer[] = [];
  private isConnected = false;
  private isClosed = false;
  private readonly autoCreateTopics: boolean;

  constructor(options: RedpandaBusOptions = {}) {
    const brokers = options.brokers
      ? Array.isArray(options.brokers)
        ? options.brokers
        : options.brokers.split(",").map((b) => b.trim())
      : ["localhost:9092"];

    this.autoCreateTopics = options.autoCreateTopics ?? true;

    this.kafka = new Kafka({
      clientId: options.clientId ?? "ai-revenue-recovery",
      brokers,
      logLevel: logLevel.NOTHING,
    });
  }

  private async getProducer(): Promise<Producer> {
    if (!this.producer) {
      this.producer = this.kafka.producer();
      await this.producer.connect();
      this.isConnected = true;
    }
    return this.producer;
  }

  /**
   * Ensures all required topics exist on the broker (s-11 §Requirements 2).
   */
  async ensureTopics(): Promise<void> {
    if (!this.admin) {
      this.admin = this.kafka.admin();
      await this.admin.connect();
    }

    try {
      const existingTopics = await this.admin.listTopics();
      const missingTopics = ALL_TOPICS.filter((t) => !existingTopics.includes(t));

      if (missingTopics.length > 0) {
        await this.admin.createTopics({
          topics: missingTopics.map((topic) => ({
            topic,
            numPartitions: 3,
            replicationFactor: 1,
          })),
        });
      }
    } catch {
      // Topic creation might fail if user does not have admin permissions or topics exist
    }
  }

  async publish(event: DomainEvent, opts?: PublishOptions): Promise<void> {
    if (this.isClosed) {
      throw new Error("Cannot publish to closed RedpandaEventBus");
    }

    const topic = opts?.topic ?? TOPIC_MAIN;
    const key = opts?.key ?? event.tenant_id;
    const rawHeaders: BusMessageHeaders = {
      ...(opts?.headers ?? {}),
      "x-correlation-id": event.correlation_id,
      traceparent: event.traceparent,
    };

    const value = encodeDomainEvent(event);
    const producer = await this.getProducer();

    await producer.send({
      topic,
      messages: [
        {
          key,
          value,
          headers: toKafkaHeaders(rawHeaders),
        },
      ],
    });

    recordBusPublished(topic);
  }

  async publishRaw(
    topic: string,
    key: string | null,
    value: string,
    headers?: BusMessageHeaders,
  ): Promise<void> {
    if (this.isClosed) {
      throw new Error("Cannot publish to closed RedpandaEventBus");
    }

    const producer = await this.getProducer();
    await producer.send({
      topic,
      messages: [
        {
          key: key ?? null,
          value,
          headers: toKafkaHeaders(headers),
        },
      ],
    });

    recordBusPublished(topic);
  }

  async subscribe(
    topic: string,
    group: string,
    handler: EventHandler,
    opts?: SubscribeOptions,
  ): Promise<void> {
    if (this.isClosed) {
      throw new Error("Cannot subscribe to closed RedpandaEventBus");
    }

    if (this.autoCreateTopics) {
      await this.ensureTopics().catch(() => {});
    }

    const consumer = this.kafka.consumer({
      groupId: group,
      allowAutoTopicCreation: true,
    });

    await consumer.connect();
    await consumer.subscribe({
      topic,
      fromBeginning: opts?.fromBeginning ?? false,
    });

    this.consumers.push(consumer);

    await consumer.run({
      autoCommit: opts?.autoCommit ?? true,
      eachMessage: async ({ message, partition, topic: msgTopic }) => {
        const key = message.key ? message.key.toString("utf8") : null;
        const headers = fromKafkaHeaders(
          message.headers as Record<string, Buffer | string | undefined>,
        );

        await processConsumerMessage({
          topic: msgTopic,
          group,
          key,
          value: message.value,
          headers,
          handler,
          publishToRetry: async (event, retryHeaders) => {
            await this.publish(event, {
              topic: TOPIC_RETRY,
              key: key ?? event.tenant_id,
              headers: retryHeaders,
            });
          },
          publishToDlq: async (dlqMsg, dlqHeaders) => {
            await this.publishRaw(
              TOPIC_DLQ,
              key,
              JSON.stringify(dlqMsg),
              dlqHeaders,
            );
          },
          commit: async () => {
            // Manual offset commit acknowledged by Kafka consumer
          },
        });
      },
    });
  }

  async close(): Promise<void> {
    this.isClosed = true;

    for (const consumer of this.consumers) {
      try {
        await consumer.disconnect();
      } catch {
        // ignore disconnect errors during teardown
      }
    }
    this.consumers.length = 0;

    if (this.producer) {
      try {
        await this.producer.disconnect();
      } catch {
        // ignore disconnect errors
      }
      this.producer = null;
    }

    if (this.admin) {
      try {
        await this.admin.disconnect();
      } catch {
        // ignore disconnect errors
      }
      this.admin = null;
    }

    this.isConnected = false;
  }
}
