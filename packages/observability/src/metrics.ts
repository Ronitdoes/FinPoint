import {
  Registry,
  Counter,
  Histogram,
  Gauge,
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

export const policyRejectionsTotal = new Counter({
  name: "policy_rejections_total",
  help: "Total number of policy rule rejections partitioned by rule code and reason",
  labelNames: ["rule_code", "reason"] as const,
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

export const providerDeclineTotal = new Counter({
  name: "provider_decline_total",
  help: "Total decline events received from payment providers partitioned by provider and decline code",
  labelNames: ["provider", "decline_code"] as const,
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

export function recordProviderDecline(
  provider: string,
  declineCode: string,
): void {
  providerDeclineTotal.inc({ provider, decline_code: declineCode });
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

// 15. Recovery Case Pipeline & Orchestration Metrics (Step 17 §Observability)
export const pipelineStageDurationMs = new Histogram({
  name: "pipeline_stage_duration_ms",
  help: "Duration of recovery case pipeline stages in milliseconds",
  labelNames: ["stage"] as const,
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [metricsRegistry],
});

export const caseFunnelTotal = new Counter({
  name: "case_funnel_total",
  help: "Recovery case orchestration funnel progression counter",
  labelNames: ["stage"] as const,
  registers: [metricsRegistry],
});

export function recordPipelineStageDuration(
  stage: string,
  durationMs: number,
): void {
  pipelineStageDurationMs.observe({ stage }, durationMs);
}

export function recordCaseFunnel(
  stage: "opened" | "qualified" | "decided" | "allowed" | "started" | string,
): void {
  caseFunnelTotal.inc({ stage });
}

// 16. Human-in-the-Loop & Approval Metrics (Step 21 — Spec 01 §19/§20)
export const humanTasksOpen = new Gauge({
  name: "human_tasks_open",
  help: "Current number of open/pending human escalation tasks partitioned by task type",
  labelNames: ["type"] as const,
  registers: [metricsRegistry],
});

export const approvalLatencyMs = new Histogram({
  name: "approval_latency_ms",
  help: "Time elapsed from human task creation to operator decision in milliseconds",
  labelNames: ["type", "decision"] as const,
  buckets: [1000, 5000, 15000, 60000, 300000, 900000, 3600000, 14400000, 86400000],
  registers: [metricsRegistry],
});

export const slaBreachTotal = new Counter({
  name: "sla_breach_total",
  help: "Total number of human escalation tasks that breached their SLA target",
  labelNames: ["type"] as const,
  registers: [metricsRegistry],
});

export function recordHumanTasksOpen(type: string, count: number): void {
  humanTasksOpen.set({ type }, count);
}

export function incHumanTasksOpen(type: string, value = 1): void {
  humanTasksOpen.inc({ type }, value);
}

export function decHumanTasksOpen(type: string, value = 1): void {
  humanTasksOpen.dec({ type }, value);
}

export function recordApprovalLatency(
  type: string,
  decision: "APPROVED" | "REJECTED" | string,
  latencyMs: number,
): void {
  approvalLatencyMs.observe({ type, decision }, latencyMs);
}

export function recordSlaBreach(type: string): void {
  slaBreachTotal.inc({ type });
}

// 17. Audit Subsystem Metrics (Step 25 — Spec 01 §18, Step 25)
export const auditWriteFailuresTotal = new Counter({
  name: "audit_write_failures_total",
  help: "Total number of failed audit/case-event write attempts (structural or role violations)",
  registers: [metricsRegistry],
});

export function recordAuditWriteFailure(): void {
  auditWriteFailuresTotal.inc();
}

// 18. Outcomes, Attribution & Cost Model Metrics (Step 26 — Spec 01 §25, Spec 02 §8/§9)
export const outcomeRecordedTotal = new Counter({
  name: "outcome_recorded_total",
  help: "Total number of authoritative recovery outcomes recorded by attribution method",
  labelNames: ["method"] as const,
  registers: [metricsRegistry],
});

export const attributionSweeperMatchesTotal = new Counter({
  name: "attribution_sweeper_matches_total",
  help: "Total number of late payments successfully attributed to closed cases by the attribution sweeper",
  registers: [metricsRegistry],
});

export const costEntryGapsTotal = new Counter({
  name: "cost_entry_gaps_total",
  help: "Total number of cost entry gaps detected and remediated by the cost completeness audit job",
  labelNames: ["category"] as const,
  registers: [metricsRegistry],
});

export function recordOutcomeRecorded(method: string, count = 1): void {
  outcomeRecordedTotal.inc({ method }, count);
}

export function recordAttributionSweeperMatch(count = 1): void {
  attributionSweeperMatchesTotal.inc(count);
}

export function recordCostEntryGap(category: string, count = 1): void {
  costEntryGapsTotal.inc({ category }, count);
}

// 19. Security Hardening Metrics (Step 30 — Spec 03 §11)
export const securityRatelimitHitsTotal = new Counter({
  name: "security_ratelimit_hits_total",
  help: "Total number of HTTP requests rejected by rate limiting partitioned by route class",
  labelNames: ["route_class"] as const,
  registers: [metricsRegistry],
});

export const securitySignatureFailuresTotal = new Counter({
  name: "security_signature_failures_total",
  help: "Total number of webhook signature verification failures partitioned by provider",
  labelNames: ["provider"] as const,
  registers: [metricsRegistry],
});

export const securityIpBlocksTotal = new Counter({
  name: "security_ip_blocks_total",
  help: "Total number of temporary IP blocks imposed after repeated signature failures",
  labelNames: ["reason"] as const,
  registers: [metricsRegistry],
});

export function recordRatelimitHit(routeClass: string): void {
  securityRatelimitHitsTotal.inc({ route_class: routeClass });
}

export function recordSignatureFailure(provider: string): void {
  securitySignatureFailuresTotal.inc({ provider });
}

export function recordIpBlock(reason: string): void {
  securityIpBlocksTotal.inc({ reason });
}

// 20. Resilience & Chaos Metrics (Step 31 — Spec 01 §21)
export const chaosFaultsInjectedTotal = new Counter({
  name: "chaos_faults_injected_total",
  help: "Total number of chaos faults injected by the fault-point harness partitioned by fault and phase",
  labelNames: ["fault", "phase"] as const,
  registers: [metricsRegistry],
});

export const executingSweeperActionsTotal = new Counter({
  name: "executing_sweeper_actions_total",
  help: "Total EXECUTING-stuck actions reconciled by the sweeper partitioned by resolution result",
  labelNames: ["result"] as const,
  registers: [metricsRegistry],
});

export const chaosBacklogDrainDurationMs = new Histogram({
  name: "chaos_backlog_drain_duration_ms",
  help: "Time taken to drain a backlogged event backlog in milliseconds",
  labelNames: ["topic"] as const,
  buckets: [100, 500, 1000, 2500, 5000, 15000, 30000, 60000],
  registers: [metricsRegistry],
});

export function recordChaosFaultInjected(fault: string, phase: string): void {
  chaosFaultsInjectedTotal.inc({ fault, phase });
}

export function recordExecutingSweeperAction(
  result: "completed" | "failed" | "pending" | string,
): void {
  executingSweeperActionsTotal.inc({ result });
}

export function recordBacklogDrain(topic: string, durationMs: number): void {
  chaosBacklogDrainDurationMs.observe({ topic }, durationMs);
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

/* ==============================================================================
 * s-34 Monitoring & Alerting instruments (Spec 01 §20, Spec 03 §10, ADR-016)
 *
 * Gauges below back the Prometheus alert rules in
 * `infra/prometheus/rules.yml` and the four Grafana dashboards in
 * `infra/grafana/dashboards/`. Label discipline (CONVENTIONS §12,
 * s-30 SECURITY-CHECKLIST §9): tenant-scoped business series carry ONLY a
 * low-cardinality `tenant` label (staging|prod aggregate or hashed tenant
 * cohort) — never raw tenant UUIDs, emails, phones, or case IDs — so no
 * business PII ever lands in an exported label.
 * ============================================================================== */

// 21. Event-bus depth & lag (BusDLQDepth alert; Operations dashboard)
export const busDlqDepth = new Gauge({
  name: "bus_dlq_depth",
  help: "Current number of messages parked in the event-bus dead-letter queue",
  labelNames: ["group"] as const,
  registers: [metricsRegistry],
});

export const busConsumerLagSeconds = new Gauge({
  name: "bus_consumer_lag_seconds",
  help: "Event-bus consumer lag behind the log tip in seconds",
  labelNames: ["group"] as const,
  registers: [metricsRegistry],
});

export function setBusDlqDepth(group: string, depth: number): void {
  busDlqDepth.set({ group }, depth);
}

export function setBusConsumerLag(group: string, lagSeconds: number): void {
  busConsumerLagSeconds.set({ group }, lagSeconds);
}

// 22. DB pool saturation (DBPoolSaturation alert; Infra dashboard)
// Values are sampled by the backend infra-sampler job
// (apps/backend/src/jobs/infra-sampler.ts) from the pg pool stats.
export const dbPoolUsed = new Gauge({
  name: "db_pool_used",
  help: "Number of database pool connections currently checked out",
  registers: [metricsRegistry],
});

export const dbPoolMax = new Gauge({
  name: "db_pool_max",
  help: "Maximum database pool size configured for this process",
  registers: [metricsRegistry],
});

export const dbPoolSaturationRatio = new Gauge({
  name: "db_pool_saturation_ratio",
  help: "Fraction of the database pool currently in use (0..1)",
  registers: [metricsRegistry],
});

export function setDbPoolStats(used: number, max: number): void {
  const safeMax = max > 0 ? max : 1;
  dbPoolUsed.set(used);
  dbPoolMax.set(max);
  dbPoolSaturationRatio.set(Math.min(1, Math.max(0, used / safeMax)));
}

// 23. Temporal worker capacity (TemporalWorkerPollers alert; Infra dashboard)
export const temporalWorkerPollers = new Gauge({
  name: "temporal_worker_pollers",
  help: "Number of active Temporal worker pollers for the recovery task queue",
  labelNames: ["queue"] as const,
  registers: [metricsRegistry],
});

export const temporalActivitySlots = new Gauge({
  name: "temporal_activity_slots_available",
  help: "Number of free Temporal activity execution slots",
  labelNames: ["queue"] as const,
  registers: [metricsRegistry],
});

export function setTemporalWorkerStats(
  queue: string,
  pollers: number,
  freeSlots: number,
): void {
  temporalWorkerPollers.set({ queue }, pollers);
  temporalActivitySlots.set({ queue }, freeSlots);
}

// 24. Approval queue depth & age (AI dashboard; LLMFallback degraded doctrine)
export const approvalOldestAgeSeconds = new Gauge({
  name: "approval_oldest_age_seconds",
  help: "Age of the oldest undecided human approval task in seconds",
  registers: [metricsRegistry],
});

export function setApprovalOldestAge(ageSeconds: number): void {
  approvalOldestAgeSeconds.set(Math.max(0, ageSeconds));
}

// 25. Business KPI gauges (Executive dashboard; ADR-016 pushgateway path)
// The kpi-snapshot job (apps/backend/src/jobs/kpi-snapshot.ts) refreshes
// these every 5 minutes from the analytics views, then mirrors the same
// values to the Prometheus pushgateway with tenant=staging|prod labels so
// Grafana reads numbers identical to the dashboard API by construction.
export const kpiRevenueAtRisk = new Gauge({
  name: "kpi_revenue_at_risk_minor",
  help: "Revenue at risk in integer minor units (paise/cents), analytics view snapshot",
  labelNames: ["tenant"] as const,
  registers: [metricsRegistry],
});

export const kpiRevenueRecovered = new Gauge({
  name: "kpi_revenue_recovered_minor",
  help: "Revenue recovered in integer minor units (paise/cents), analytics view snapshot",
  labelNames: ["tenant"] as const,
  registers: [metricsRegistry],
});

export const kpiNetRecovered = new Gauge({
  name: "kpi_net_recovered_minor",
  help: "Net recovered (recovered minus costs) in minor units, analytics view snapshot",
  labelNames: ["tenant"] as const,
  registers: [metricsRegistry],
});

export const kpiRecoveryRate = new Gauge({
  name: "kpi_recovery_rate",
  help: "Recovery rate fraction 0..1 from the analytics summary view",
  labelNames: ["tenant"] as const,
  registers: [metricsRegistry],
});

export const kpiActiveCases = new Gauge({
  name: "kpi_active_cases",
  help: "Current number of non-terminal recovery cases, analytics view snapshot",
  labelNames: ["tenant"] as const,
  registers: [metricsRegistry],
});

export const kpiEscalations = new Gauge({
  name: "kpi_escalations_total",
  help: "Cumulative escalated recovery cases, analytics view snapshot",
  labelNames: ["tenant"] as const,
  registers: [metricsRegistry],
});

export interface KpiSnapshot {
  tenant: string;
  revenueAtRiskMinor: number;
  revenueRecoveredMinor: number;
  netRecoveredMinor: number;
  recoveryRate: number;
  activeCases: number;
  escalations: number;
}

export function setKpiSnapshot(snap: KpiSnapshot): void {
  const { tenant } = snap;
  kpiRevenueAtRisk.set({ tenant }, snap.revenueAtRiskMinor);
  kpiRevenueRecovered.set({ tenant }, snap.revenueRecoveredMinor);
  kpiNetRecovered.set({ tenant }, snap.netRecoveredMinor);
  kpiRecoveryRate.set({ tenant }, snap.recoveryRate);
  kpiActiveCases.set({ tenant }, snap.activeCases);
  kpiEscalations.set({ tenant }, snap.escalations);
}

// 26. Ops-hygiene gauges (CertExpiry / DiskFills alerts; Infra dashboard)
// Sourced from node_exporter / blackbox exporter in staging+prod; the
// setters exist so synthetic firing drills (s-34 Tests) can force the
// paging path without touching real certificates or disks.
export const certExpiryDays = new Gauge({
  name: "cert_expiry_days",
  help: "Days until the public TLS certificate expires",
  labelNames: ["host"] as const,
  registers: [metricsRegistry],
});

export const diskFreeRatio = new Gauge({
  name: "disk_free_ratio",
  help: "Fraction of disk space still free (0..1) per mountpoint",
  labelNames: ["mountpoint"] as const,
  registers: [metricsRegistry],
});

export const redisMemoryRatio = new Gauge({
  name: "redis_memory_ratio",
  help: "Fraction of Redis maxmemory currently used (0..1)",
  registers: [metricsRegistry],
});

export function setCertExpiryDays(host: string, days: number): void {
  certExpiryDays.set({ host }, days);
}

export function setDiskFreeRatio(mountpoint: string, ratio: number): void {
  diskFreeRatio.set({ mountpoint }, ratio);
}

export function setRedisMemoryRatio(ratio: number): void {
  redisMemoryRatio.set(Math.min(1, Math.max(0, ratio)));
}
