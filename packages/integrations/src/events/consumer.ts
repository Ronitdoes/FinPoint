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
 * Default ceiling for a single handler invocation (CONVENTIONS §8, s-11 gaps).
 * A handler that neither resolves nor rejects within this window is treated
 * as a transient failure: the wait is abandoned with a RETRYABLE error so the
 * bus framework retries/DLQs instead of blocking the partition (Redpanda
 * `eachMessage`) or the per-tenant chain (InProcess `enqueuePerTenant`)
 * forever. Override per call via `ProcessMessageParams.handlerTimeoutMs`.
 */
export const HANDLER_TIMEOUT_MS = 30000; // 30 seconds

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
  /**
   * Ceiling for a single handler invocation in ms (default
   * HANDLER_TIMEOUT_MS). A hung handler yields a RETRYABLE timeout error so
   * the message is retried/DLQ'd instead of head-of-line blocking the
   * consumer. Values <= 0 disable the timeout (not recommended).
   */
  handlerTimeoutMs?: number;
}

/**
 * Races a handler invocation against a timeout (CONVENTIONS §8).
 *
 * On timeout the wait is abandoned with a `RetryableError` so the shared
 * consumer engine classifies it RETRYABLE and routes to the retry topic /
 * DLQ. Asymmetry note: JavaScript cannot cancel the underlying handler —
 * a hung handler keeps running in the background and its eventual result is
 * ignored. Handlers MUST therefore be idempotent (at-least-once delivery
 * already requires this): a timed-out handler that later completes must be
 * a safe duplicate of the retry. The timer is always cleared once the race
 * settles so timed-out waits never leak handles.
 */
export async function invokeHandlerWithTimeout(
  handler: EventHandler,
  event: DomainEvent,
  ctx: EventContext,
  timeoutMs: number = HANDLER_TIMEOUT_MS,
): Promise<void> {
  if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
    await handler(event, ctx);
    return;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new RetryableError(
          `Event handler timed out after ${timeoutMs}ms ` +
            `(group=${ctx.group} topic=${ctx.topic} event=${event.id}); ` +
            `abandoning wait so the message can retry/DLQ`,
        ),
      );
    }, timeoutMs);
    // Don't hold the process open for a wait we've already abandoned.
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  try {
    await Promise.race([handler(event, ctx), timeoutPromise]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
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
    handlerTimeoutMs = HANDLER_TIMEOUT_MS,
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

  // 2. Invoke Handler (bounded: hung handlers time out RETRYABLE instead
  // of head-of-line blocking the consumer forever).
  try {
    await invokeHandlerWithTimeout(handler, event, ctx, handlerTimeoutMs);

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
