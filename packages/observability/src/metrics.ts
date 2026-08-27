import {
  Registry,
  Counter,
  Histogram,
  collectDefaultMetrics,
  type DefaultMetricsCollectorConfiguration,
} from "prom-client";

/**
 * Singleton metrics registry for Prometheus-compatible exposition.
 */
export const metricsRegistry = new Registry();

// Collect node/process runtime metrics with prefix arr_
collectDefaultMetrics({
  register: metricsRegistry,
  prefix: "arr_",
});

/* ==============================================================================
 * Spec 01 §20 & s-08 Core Metric Instruments
 * ============================================================================== */

// 1. HTTP Metrics
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests processed by the API gateway",
  labelNames: ["route", "method", "status"] as const,
  registers: [metricsRegistry],
});

export const httpRequestDurationMs = new Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request latency distribution in milliseconds",
  labelNames: ["route", "method", "status"] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [metricsRegistry],
});

// 2. Database Metrics
export const dbQueryDurationMs = new Histogram({
  name: "db_query_duration_ms",
  help: "Database query execution duration in milliseconds",
  labelNames: ["operation", "table"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [metricsRegistry],
});

// 3. Ingestion & Events Metrics
export const eventsIngestedTotal = new Counter({
  name: "events_ingested_total",
  help: "Total number of inbound events ingested across all providers",
  labelNames: ["source", "type"] as const,
  registers: [metricsRegistry],
});

export const eventsDuplicateTotal = new Counter({
  name: "events_duplicate_total",
  help: "Total number of duplicate events detected and dropped by idempotency layer",
  labelNames: ["source"] as const,
  registers: [metricsRegistry],
});

// 4. Risk Engine Metrics
export const riskCalculationsDurationMs = new Histogram({
  name: "risk_calculations_duration_ms",
  help: "Time spent calculating deterministic risk scores in milliseconds",
  labelNames: ["risk_band"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250, 500],
  registers: [metricsRegistry],
});

// 5. Policy Engine Metrics
export const policyEvaluationsTotal = new Counter({
  name: "policy_evaluations_total",
  help: "Total number of policy evaluations partitioned by result (approved, rejected, human_escalated)",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

export const policyEvaluationDurationMs = new Histogram({
  name: "policy_evaluation_duration_ms",
  help: "Time spent evaluating policy rules in milliseconds",
  labelNames: ["rule_set"] as const,
  buckets: [1, 5, 10, 25, 50, 100, 250],
  registers: [metricsRegistry],
});

// 6. AI Decision Service Metrics (Spec 01 §20, emitted in s-14)
export const llmCallsTotal = new Counter({
  name: "llm_calls_total",
  help: "Total number of LLM inference calls",
  labelNames: ["model", "status"] as const,
  registers: [metricsRegistry],
});

export const llmLatencyMs = new Histogram({
  name: "llm_latency_ms",
  help: "LLM round-trip call latency in milliseconds",
  labelNames: ["model"] as const,
  buckets: [100, 250, 500, 1000, 2000, 5000, 10000, 20000],
  registers: [metricsRegistry],
});

export const llmTokensTotal = new Counter({
  name: "llm_tokens_total",
  help: "Total tokens consumed by LLM calls",
  labelNames: ["kind", "model"] as const, // kind: prompt | completion | total
  registers: [metricsRegistry],
});

export const fallbackTotal = new Counter({
  name: "fallback_total",
  help: "Total number of fallback recommendations triggered",
  labelNames: ["reason"] as const,
  registers: [metricsRegistry],
});

// 7. Provider Integration Metrics (emitted s-18 / s-19)
export const providerCallsTotal = new Counter({
  name: "provider_calls_total",
  help: "Total calls made to external integration providers (Stripe, Razorpay, WhatsApp, Email)",
  labelNames: ["provider", "op", "status"] as const,
  registers: [metricsRegistry],
});

export const providerLatencyMs = new Histogram({
  name: "provider_latency_ms",
  help: "Latency of external provider operations in milliseconds",
  labelNames: ["provider", "op"] as const,
  buckets: [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
  registers: [metricsRegistry],
});

// 8. Workflow Metrics (emitted s-20+)
export const workflowStartedTotal = new Counter({
  name: "workflow_started_total",
  help: "Total number of Temporal workflows initiated",
  labelNames: ["type"] as const,
  registers: [metricsRegistry],
});

export const workflowOutcomeTotal = new Counter({
  name: "workflow_outcome_total",
  help: "Total number of workflow completions partitioned by type and terminal outcome",
  labelNames: ["type", "result"] as const,
  registers: [metricsRegistry],
});

// 9. Auth & Security Metrics (Step 09)
export const authLoginsTotal = new Counter({
  name: "auth_logins_total",
  help: "Total number of login attempts partitioned by result",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

export const authFailuresTotal = new Counter({
  name: "auth_failures_total",
  help: "Total number of authentication failures partitioned by reason",
  labelNames: ["reason"] as const,
  registers: [metricsRegistry],
});

// 10. Webhook Ingestion & Anti-Duplication Metrics (Step 10)
export const webhookDeliveriesTotal = new Counter({
  name: "webhook_deliveries_total",
  help: "Total number of inbound webhook deliveries partitioned by provider and delivery status",
  labelNames: ["provider", "status"] as const,
  registers: [metricsRegistry],
});

export const webhookDurationMs = new Histogram({
  name: "webhook_duration_ms",
  help: "Webhook processing latency distribution in milliseconds",
  labelNames: ["provider", "status"] as const,
  buckets: [5, 10, 25, 50, 100, 250, 300, 500, 1000, 2500],
  registers: [metricsRegistry],
});

export const eventOrderRegressionTotal = new Counter({
  name: "event_order_regression_total",
  help: "Total out-of-order events detected that would cause status regression",
  labelNames: ["provider", "entity_type", "from_status", "to_status"] as const,
  registers: [metricsRegistry],
});

// 11. Event Bus Metrics (Step 11 — Spec 01 §20)
export const busPublishedTotal = new Counter({
  name: "bus_published_total",
  help: "Total events published onto the event bus partitioned by topic",
  labelNames: ["topic"] as const,
  registers: [metricsRegistry],
});

export const busConsumedTotal = new Counter({
  name: "bus_consumed_total",
  help: "Total events processed by event bus consumers partitioned by consumer group and outcome status",
  labelNames: ["group", "status"] as const, // status: success | retry | dlq | poison
  registers: [metricsRegistry],
});

export const busRetryTotal = new Counter({
  name: "bus_retry_total",
  help: "Total retry attempts initiated by event bus consumer groups",
  labelNames: ["group"] as const,
  registers: [metricsRegistry],
});

export const busDlqTotal = new Counter({
  name: "bus_dlq_total",
  help: "Total dead-letter events routed to DLQ by consumer groups",
  labelNames: ["group"] as const,
  registers: [metricsRegistry],
});

// 12. Customer Context Metrics (Step 13)
export const contextBuildDurationMs = new Histogram({
  name: "context_build_duration_ms",
  help: "Time spent constructing customer context in milliseconds",
  labelNames: ["purpose"] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
  registers: [metricsRegistry],
});

export const contextBytes = new Histogram({
  name: "context_bytes",
  help: "Serialized customer context size in bytes",
  labelNames: ["purpose"] as const,
  buckets: [256, 512, 1024, 2048, 4096, 8192, 16384],
  registers: [metricsRegistry],
});

/* ==============================================================================
 * Typed Helper Functions for Safe Metric Recording
 * ============================================================================== */

export function recordHttpRequest(
  method: string,
  route: string,
  status: number | string,
  durationMs: number,
): void {
  const statusStr = String(status);
  httpRequestsTotal.inc({ route, method, status: statusStr });
  httpRequestDurationMs.observe({ route, method, status: statusStr }, durationMs);
}

export function recordDbQuery(
  operation: string,
  table: string,
  durationMs: number,
): void {
  dbQueryDurationMs.observe({ operation, table }, durationMs);
}

export function recordEventIngested(source: string, type: string): void {
  eventsIngestedTotal.inc({ source, type });
}

export function recordEventDuplicate(source: string): void {
  eventsDuplicateTotal.inc({ source });
}

export function recordRiskCalculation(riskBand: string, durationMs: number): void {
  riskCalculationsDurationMs.observe({ risk_band: riskBand }, durationMs);
}

export function recordPolicyEvaluation(
  result: "APPROVED" | "REJECTED" | "ESCALATED" | string,
  durationMs: number,
  ruleSet = "default",
): void {
  policyEvaluationsTotal.inc({ result });
  policyEvaluationDurationMs.observe({ rule_set: ruleSet }, durationMs);
}

export function recordLlmCall(
  model: string,
  status: "success" | "error" | string,
  latencyMs: number,
  tokens?: { prompt?: number; completion?: number; total?: number },
): void {
  llmCallsTotal.inc({ model, status });
  llmLatencyMs.observe({ model }, latencyMs);
  if (tokens?.prompt) {
    llmTokensTotal.inc({ kind: "prompt", model }, tokens.prompt);
  }
  if (tokens?.completion) {
    llmTokensTotal.inc({ kind: "completion", model }, tokens.completion);
  }
  if (tokens?.total) {
    llmTokensTotal.inc({ kind: "total", model }, tokens.total);
  }
}

export function recordFallback(reason: string): void {
  fallbackTotal.inc({ reason });
}

export function recordProviderCall(
  provider: string,
  op: string,
  status: "success" | "error" | string,
  latencyMs: number,
): void {
  providerCallsTotal.inc({ provider, op, status });
  providerLatencyMs.observe({ provider, op }, latencyMs);
}

export function recordWorkflowStarted(type: string): void {
  workflowStartedTotal.inc({ type });
}

export function recordWorkflowOutcome(type: string, result: string): void {
  workflowOutcomeTotal.inc({ type, result });
}

export function recordAuthLogin(result: "success" | "failure" | string): void {
  authLoginsTotal.inc({ result });
}

export function recordAuthFailure(reason: string): void {
  authFailuresTotal.inc({ reason });
}

export function recordWebhookDelivery(
  provider: string,
  status: "accepted" | "duplicate" | "invalid_signature" | "unmappable" | "error" | string,
): void {
  webhookDeliveriesTotal.inc({ provider, status });
}

export function recordWebhookLatency(
  provider: string,
  status: "accepted" | "duplicate" | "invalid_signature" | "unmappable" | "error" | string,
  durationMs: number,
): void {
  webhookDurationMs.observe({ provider, status }, durationMs);
}

export function recordEventOrderRegression(
  provider: string,
  entityType: string,
  fromStatus: string,
  toStatus: string,
): void {
  eventOrderRegressionTotal.inc({
    provider,
    entity_type: entityType,
    from_status: fromStatus,
    to_status: toStatus,
  });
}

export function recordBusPublished(topic: string): void {
  busPublishedTotal.inc({ topic });
}

export function recordBusConsumed(
  group: string,
  status: "success" | "retry" | "dlq" | "poison" | string,
): void {
  busConsumedTotal.inc({ group, status });
}

export function recordBusRetry(group: string): void {
  busRetryTotal.inc({ group });
}

export function recordBusDlq(group: string): void {
  busDlqTotal.inc({ group });
}

export function recordContextBuild(
  purpose: string,
  durationMs: number,
  bytes: number,
): void {
  contextBuildDurationMs.observe({ purpose }, durationMs);
  contextBytes.observe({ purpose }, bytes);
}

/**
 * Returns the Prometheus exposition text format.
 */
export async function getMetricsText(): Promise<string> {
  return await metricsRegistry.metrics();
}

/**
 * Resets all recorded metrics to initial state (useful in unit tests).
 */
export function resetMetrics(): void {
  metricsRegistry.resetMetrics();
}

/**
 * Returns Prometheus content type header value.
 */
export function getMetricsContentType(): string {
  return metricsRegistry.contentType;
}
