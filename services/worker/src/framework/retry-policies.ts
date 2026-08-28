import type { RetryPolicy } from "@temporalio/common";
import { NON_RETRYABLE_ERROR_TYPES } from "./errors";

/**
 * Standard Retry Policy for short-lived, transient-failure-prone activities
 * (initial 1s, backoff 2.0, max attempts 3, full jitter).
 * (Spec 01 §21, Spec 20 §Requirements 4).
 */
export const STANDARD_RETRY_POLICY: RetryPolicy = {
  initialInterval: "1s",
  backoffCoefficient: 2.0,
  maximumAttempts: 3,
  nonRetryableErrorTypes: [...NON_RETRYABLE_ERROR_TYPES],
};

/**
 * Provider Status Polling Retry Policy for status verification loops
 * (initial 10s, max attempts 12, backoff 1.0, with activity heartbeats).
 */
export const PROVIDER_POLL_RETRY_POLICY: RetryPolicy = {
  initialInterval: "10s",
  backoffCoefficient: 1.0,
  maximumAttempts: 12,
  nonRetryableErrorTypes: [...NON_RETRYABLE_ERROR_TYPES],
};

/**
 * Human Wait Policy (no automatic retry; signal-driven; long startToClose timeout).
 */
export const HUMAN_WAIT_RETRY_POLICY: RetryPolicy = {
  maximumAttempts: 1,
  nonRetryableErrorTypes: [...NON_RETRYABLE_ERROR_TYPES],
};

/**
 * Non-Retryable Policy for validation, policy rejections, or deterministic failure.
 */
export const NON_RETRYABLE_POLICY: RetryPolicy = {
  maximumAttempts: 1,
  nonRetryableErrorTypes: [...NON_RETRYABLE_ERROR_TYPES],
};

/**
 * Named Activity Execution Options bundles for workflow call-sites.
 */
export const ACTIVITY_OPTIONS = {
  STANDARD: {
    startToCloseTimeout: "30s",
    retry: STANDARD_RETRY_POLICY,
  },
  PROVIDER_CALL: {
    startToCloseTimeout: "45s",
    retry: STANDARD_RETRY_POLICY,
  },
  PROVIDER_POLL: {
    startToCloseTimeout: "5m",
    heartbeatTimeout: "30s",
    retry: PROVIDER_POLL_RETRY_POLICY,
  },
  HUMAN_WAIT: {
    startToCloseTimeout: "30 days",
    retry: HUMAN_WAIT_RETRY_POLICY,
  },
  FAST_LOCAL: {
    startToCloseTimeout: "10s",
    retry: NON_RETRYABLE_POLICY,
  },
} as const;
