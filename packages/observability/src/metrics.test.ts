import { describe, it, expect, beforeEach } from "vitest";
import {
  metricsRegistry,
  resetMetrics,
  getMetricsText,
  recordHttpRequest,
  recordDbQuery,
  recordEventIngested,
  recordEventDuplicate,
  recordRiskCalculation,
  recordPolicyEvaluation,
  recordLlmCall,
  recordProviderCall,
  recordWorkflowStarted,
  recordWorkflowOutcome,
  recordAiCost,
  recordRequiresApproval,
} from "./metrics";

describe("Observability Metrics", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("registers and increments HTTP request counter and histogram", async () => {
    recordHttpRequest("GET", "/health", 200, 12.5);
    recordHttpRequest("GET", "/health", 200, 15.0);
    recordHttpRequest("POST", "/webhooks/stripe", 400, 45.2);

    const metricsText = await getMetricsText();

    expect(metricsText).toContain("http_requests_total");
    expect(metricsText).toContain('http_requests_total{route="/health",method="GET",status="200"} 2');
    expect(metricsText).toContain('http_requests_total{route="/webhooks/stripe",method="POST",status="400"} 1');
    expect(metricsText).toContain("http_request_duration_ms");
  });

  it("records database query durations", async () => {
    recordDbQuery("select", "recovery_cases", 8.4);
    recordDbQuery("update", "recovery_actions", 14.1);

    const metricsText = await getMetricsText();
    expect(metricsText).toContain("db_query_duration_ms");
    expect(metricsText).toContain('operation="select",table="recovery_cases"');
    expect(metricsText).toContain('operation="update",table="recovery_actions"');
  });

  it("records event ingestion and duplicate drops", async () => {
    recordEventIngested("stripe", "payment.failed");
    recordEventDuplicate("stripe");

    const metricsText = await getMetricsText();
    expect(metricsText).toContain('events_ingested_total{source="stripe",type="payment.failed"} 1');
    expect(metricsText).toContain('events_duplicate_total{source="stripe"} 1');
  });

  it("records risk calculation and policy evaluation metrics", async () => {
    recordRiskCalculation("HIGH", 25.0);
    recordPolicyEvaluation("APPROVED", 10.0, "payment_rules");
    recordPolicyEvaluation("REJECTED", 8.0, "discount_rules");

    const metricsText = await getMetricsText();
    expect(metricsText).toContain('risk_calculations_duration_ms_count{risk_band="HIGH"} 1');
    expect(metricsText).toContain('policy_evaluations_total{result="APPROVED"} 1');
    expect(metricsText).toContain('policy_evaluations_total{result="REJECTED"} 1');
    expect(metricsText).toContain('policy_evaluation_duration_ms_count{rule_set="payment_rules"} 1');
  });

  it("records LLM calls, latency, and token accounting", async () => {
    recordLlmCall("gpt-4o", "success", 1250, {
      prompt: 450,
      completion: 120,
      total: 570,
    });

    const metricsText = await getMetricsText();
    expect(metricsText).toContain('llm_calls_total{model="gpt-4o",status="success"} 1');
    expect(metricsText).toContain('llm_latency_ms_count{model="gpt-4o"} 1');
    expect(metricsText).toContain('llm_tokens_total{kind="prompt",model="gpt-4o"} 450');
    expect(metricsText).toContain('llm_tokens_total{kind="completion",model="gpt-4o"} 120');
    expect(metricsText).toContain('llm_tokens_total{kind="total",model="gpt-4o"} 570');
  });

  it("records provider integration and workflow metrics", async () => {
    recordProviderCall("stripe", "charge", "success", 340);
    recordWorkflowStarted("FAILED_PAYMENT");
    recordWorkflowOutcome("FAILED_PAYMENT", "RECOVERED");

    const metricsText = await getMetricsText();
    expect(metricsText).toContain('provider_calls_total{provider="stripe",op="charge",status="success"} 1');
    expect(metricsText).toContain('provider_latency_ms_count{provider="stripe",op="charge"} 1');
    expect(metricsText).toContain('workflow_started_total{type="FAILED_PAYMENT"} 1');
    expect(metricsText).toContain('workflow_outcome_total{type="FAILED_PAYMENT",result="RECOVERED"} 1');
  });

  it("records s-15 AI governance cost and approval-gate metrics", async () => {
    recordAiCost("gpt-4o", "COMPLETED", 106n);
    recordAiCost("gpt-4o", "FALLBACK_RULE_BASED", 0);
    recordRequiresApproval("required");
    recordRequiresApproval("not_required");

    const metricsText = await getMetricsText();
    expect(metricsText).toContain("ai_cost_case_minor");
    expect(metricsText).toContain('ai_cost_case_minor_count{model="gpt-4o",status="COMPLETED"} 1');
    expect(metricsText).toContain('ai_requires_approval_total{result="required"} 1');
    expect(metricsText).toContain('ai_requires_approval_total{result="not_required"} 1');
  });

  it("includes all Spec 01 §20 metric definitions in registry", () => {
    const metricNames = metricsRegistry.getMetricsAsArray().map((m: { name: string }) => m.name);

    const requiredMetrics = [
      "http_requests_total",
      "http_request_duration_ms",
      "db_query_duration_ms",
      "events_ingested_total",
      "events_duplicate_total",
      "risk_calculations_duration_ms",
      "policy_evaluations_total",
      "policy_evaluation_duration_ms",
      "llm_calls_total",
      "llm_latency_ms",
      "llm_tokens_total",
      "provider_calls_total",
      "provider_latency_ms",
      "workflow_started_total",
      "workflow_outcome_total",
      "ai_cost_case_minor",
      "ai_requires_approval_total",
    ];

    for (const name of requiredMetrics) {
      expect(metricNames).toContain(name);
    }
  });
});
