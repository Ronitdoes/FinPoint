import type { DomainEvent } from "@repo/domain";
import {
  recordBusConsumed,
  recordBusRetry,
  recordBusDlq,
} from "@repo/observability";
import { decodeDomainEvent } from "./envelope-codec";
import type {
  BusMessageHeaders,
  DlqMessage,
  EventContext,
  EventHandler,
} from "./event-bus";

/**
 * Standard retry policy constants (Spec 01 §0, s-11 §Reliability).
 */
export const BASE_BACKOFF_MS = 1000; // 1 second
export const BACKOFF_FACTOR = 2;
export const MAX_BACKOFF_MS = 60000; // 60 seconds
export const MAX_RETRY_ATTEMPTS = 5;

/**
 * Explicit error indicating the operation is transient and safe to retry.
 */
export class RetryableError extends Error {
  readonly isRetryable = true;
  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = "RetryableError";
  }
}

/**
 * Explicit error indicating the operation is non-transient and must NOT be retried.
 */
export class NonRetryableError extends Error {
  readonly isRetryable = false;
  constructor(message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = "NonRetryableError";
  }
}

/**
 * Classifies an error into RETRYABLE or NON_RETRYABLE (s-11 §Reliability).
 *
 * RETRYABLE:
 *   - Network timeouts, connection resets, broker unavailable
 *   - Database serialization / deadlock errors (PostgreSQL 40001, 40P01)
 *   - Downstream 5xx errors
 *
 * NON_RETRYABLE:
 *   - Validation failure (Zod errors, schema invalidation)
 *   - Entity not found, policy hard-stop, 4xx errors
 *   - NonRetryableError instances
 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  if (error instanceof RetryableError || (error as any).isRetryable === true) {
    return true;
  }

  if (
    error instanceof NonRetryableError ||
    (error as any).isRetryable === false
  ) {
    return false;
  }

  const err = error as any;

  // Check HTTP status codes
  const status = err.status ?? err.statusCode;
  if (typeof status === "number") {
    if (status >= 500) return true;
    if (status >= 400 && status < 500) return false;
  }

  // Check PostgreSQL error codes
  const code = String(err.code || "");
  if (code === "40001" || code === "40P01") {
    // 40001 = serialization_failure, 40P01 = deadlock_detected
    return true;
  }

  // Check network error codes
  const networkCodes = [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "AbortError",
    "TimeoutError",
  ];
  if (networkCodes.includes(code) || networkCodes.includes(err.name)) {
    return true;
  }

  // Check message text for transient indicators
  const msg = String(err.message || "").toLowerCase();
  if (
    msg.includes("timeout") ||
    msg.includes("connection reset") ||
    msg.includes("deadlock detected") ||
    msg.includes("could not serialize access") ||
    msg.includes("broker unavailable") ||
    msg.includes("econnrefused")
  ) {
    return true;
  }

  return false;
}

/**
 * Calculates exponential backoff delay with full jitter (s-11 §Reliability).
 * delay = random(0, min(max, base * factor^(attempt - 1)))
 */
export function calculateBackoffMs(
  attempt: number,
  base: number = BASE_BACKOFF_MS,
  factor: number = BACKOFF_FACTOR,
  max: number = MAX_BACKOFF_MS,
): number {
  const effectiveAttempt = Math.max(1, attempt);
  const expDelay = Math.min(max, base * Math.pow(factor, effectiveAttempt - 1));
  return Math.floor(Math.random() * expDelay);
}

export interface ProcessMessageParams {
  topic: string;
  group: string;
  key: string | null;
  value: string | Buffer | null | undefined;
  headers: BusMessageHeaders;
  handler: EventHandler;
  publishToRetry: (
    event: DomainEvent,
    headers: BusMessageHeaders,
  ) => Promise<void>;
  publishToDlq: (
    dlqMessage: DlqMessage,
    headers: BusMessageHeaders,
  ) => Promise<void>;
  commit: () => Promise<void>;
}

/**
 * Shared consumer engine across both Redpanda and InProcess event bus drivers.
 * Implements decoding, poison pill routing, handler invocation, exponential retry, and DLQ routing.
 */
export async function processConsumerMessage(
  params: ProcessMessageParams,
): Promise<void> {
  const {
    topic,
    group,
    value,
    headers,
    handler,
    publishToRetry,
    publishToDlq,
    commit,
  } = params;

  const attempt = parseInt(headers["x-attempt"] || "1", 10);
  const firstSeenAt = headers["x-first-seen"] || new Date().toISOString();
  const originalTopic = headers["x-original-topic"] || topic;

  // 1. Decode & Validate Envelope (Poison Message Detection)
  const decodeResult = decodeDomainEvent(value);

  if (!decodeResult.success) {
    // Poison Pill: invalid envelope or malformed JSON -> immediately route to DLQ with NO retries
    recordBusConsumed(group, "poison");

    const dlqMessage: DlqMessage = {
      originalEnvelope: decodeResult.rawPayload ?? value,
      error: {
        code: "SCHEMA_VALIDATION_FAILED",
        message: decodeResult.error.message,
        stack: decodeResult.error.stack,
      },
      attempts: attempt,
      firstTopic: originalTopic,
      failedAt: new Date().toISOString(),
    };

    await publishToDlq(dlqMessage, {
      ...headers,
      "x-attempt": String(attempt),
      "x-first-seen": firstSeenAt,
      "x-last-error": decodeResult.error.message,
      "x-original-topic": originalTopic,
    });

    recordBusDlq(group);
    await commit();
    return;
  }

  const event = decodeResult.event;
  const ctx: EventContext = {
    topic,
    group,
    attempt,
    firstSeenAt,
    headers,
    correlationId: event.correlation_id,
  };

  // 2. Invoke Handler
  try {
    await handler(event, ctx);

    // Handler succeeded -> record metric and commit offset
    recordBusConsumed(group, "success");
    await commit();
  } catch (error: any) {
    const retryable = isRetryableError(error);
    const errorMsg = error instanceof Error ? error.message : String(error);

    if (retryable && attempt < MAX_RETRY_ATTEMPTS) {
      // 3. Retry Path: Calculate exponential backoff with full jitter and re-publish to retry topic
      const nextAttempt = attempt + 1;
      const delayMs = calculateBackoffMs(nextAttempt);
      const delayUntil = new Date(Date.now() + delayMs).toISOString();

      const retryHeaders: BusMessageHeaders = {
        ...headers,
        "x-attempt": String(nextAttempt),
        "x-first-seen": firstSeenAt,
        "x-last-error": errorMsg,
        "x-original-topic": originalTopic,
        "x-delay-until": delayUntil,
      };

      await publishToRetry(event, retryHeaders);
      recordBusConsumed(group, "retry");
      recordBusRetry(group);
      await commit();
    } else {
      // 4. Exhausted attempts or Non-Retryable Error -> Route to DLQ
      const errorCode =
        error?.code ||
        (attempt >= MAX_RETRY_ATTEMPTS
          ? "MAX_RETRIES_EXCEEDED"
          : error?.name || "NON_RETRYABLE_ERROR");

      const dlqMessage: DlqMessage = {
        originalEnvelope: event,
        error: {
          code: String(errorCode),
          message: errorMsg,
          stack: error instanceof Error ? error.stack : undefined,
        },
        attempts: attempt,
        firstTopic: originalTopic,
        failedAt: new Date().toISOString(),
      };

      await publishToDlq(dlqMessage, {
        ...headers,
        "x-attempt": String(attempt),
        "x-first-seen": firstSeenAt,
        "x-last-error": errorMsg,
        "x-original-topic": originalTopic,
      });

      recordBusConsumed(group, "dlq");
      recordBusDlq(group);
      await commit();
    }
  }
}
