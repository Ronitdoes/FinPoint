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
