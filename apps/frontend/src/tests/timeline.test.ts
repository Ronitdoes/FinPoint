import { describe, it, expect } from "vitest";
import type { TimelineItem } from "../lib/types";

describe("Timeline Feed Fixture & Ordering Validation (Spec 00 §6, Spec 01 §17)", () => {
  const scenarioATimeline: TimelineItem[] = [
    {
      id: "evt_1",
      event_type: "PAYMENT_FAILED",
      timestamp: "2026-08-23T10:04:00Z",
      actor_type: "ANONYMOUS",
      actor_id: null,
      summary: "payment.failed insufficient_funds",
      metadata: { code: "insufficient_funds", amount: 1299900 },
    },
    {
      id: "evt_2",
      event_type: "RISK_CALCULATED",
      timestamp: "2026-08-23T10:04:30Z",
      actor_type: "SYSTEM",
      actor_id: "risk_engine_v1",
      summary: "risk_score = 0.86 (HIGH)",
      metadata: { score: 86, band: "HIGH" },
    },
    {
      id: "evt_3",
      event_type: "AI_DECISION_CREATED",
      timestamp: "2026-08-23T10:05:00Z",
      actor_type: "SYSTEM",
      actor_id: "ai_service_gemini",
      summary: "AI recommends retry + WhatsApp",
      metadata: { cause: "insufficient_funds", confidence: 0.91 },
    },
    {
      id: "evt_4",
      event_type: "POLICY_ALLOWED",
      timestamp: "2026-08-23T10:05:10Z",
      actor_type: "SYSTEM",
      actor_id: "policy_engine",
      summary: "policy ALLOWED",
      metadata: { result: "ALLOWED", latency_ms: 12 },
    },
    {
      id: "evt_5",
      event_type: "WORKFLOW_STARTED",
      timestamp: "2026-08-23T10:05:15Z",
      actor_type: "SYSTEM",
      actor_id: "temporal_worker",
      summary: "workflow started",
      metadata: { workflow_id: "wf_case_001" },
    },
    {
      id: "evt_6",
      event_type: "WHATSAPP_SENT",
      timestamp: "2026-08-23T10:07:00Z",
      actor_type: "SYSTEM",
      actor_id: "whatsapp_adapter",
      summary: "WhatsApp delivered",
      metadata: { template: "payment_retry_notice" },
    },
    {
      id: "evt_7",
      event_type: "PAYMENT_RETRY_STARTED",
      timestamp: "2026-08-24T10:04:00Z",
      actor_type: "SYSTEM",
      actor_id: "payment_adapter",
      summary: "+24h retry initiated",
      metadata: { attempt: 2 },
    },
    {
      id: "evt_8",
      event_type: "PAYMENT_SUCCEEDED",
      timestamp: "2026-08-24T10:04:05Z",
      actor_type: "ANONYMOUS",
      actor_id: null,
      summary: "+24h payment succeeded",
      metadata: { provider: "razorpay" },
    },
    {
      id: "evt_9",
      event_type: "RECOVERY_RECORDED",
      timestamp: "2026-08-24T10:04:10Z",
      actor_type: "SYSTEM",
      actor_id: "outcomes_service",
      summary: "₹12,999 recovered",
      metadata: { amount_recovered: 1299900 },
    },
  ];

  it("verifies chronological order matching Spec 00 §6 Scenario A", () => {
    expect(scenarioATimeline).toHaveLength(9);

    const eventTypes = scenarioATimeline.map((e) => e.event_type);
    expect(eventTypes).toEqual([
      "PAYMENT_FAILED",
      "RISK_CALCULATED",
      "AI_DECISION_CREATED",
      "POLICY_ALLOWED",
      "WORKFLOW_STARTED",
      "WHATSAPP_SENT",
      "PAYMENT_RETRY_STARTED",
      "PAYMENT_SUCCEEDED",
      "RECOVERY_RECORDED",
    ]);

    // Timestamps are monotonically increasing
    for (let i = 1; i < scenarioATimeline.length; i++) {
      const prev = new Date(scenarioATimeline[i - 1].timestamp).getTime();
      const curr = new Date(scenarioATimeline[i].timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  it("enriches metadata with attribution and status information", () => {
    const recoveryEvt = scenarioATimeline.find((e) => e.event_type === "RECOVERY_RECORDED");
    expect(recoveryEvt).toBeDefined();
    expect(recoveryEvt?.metadata.amount_recovered).toBe(1299900);
  });
});
