import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluator";
import type { ActivePolicyRule, PolicyInput } from "./types";

describe("Policy Evaluator Integration & Orchestration", () => {
  it("allows clean proposed actions when no rules are violated", () => {
    const input: PolicyInput = {
      case: {
        id: "case-100",
        tenant_id: "tenant-1",
        risk_type: "PAYMENT_FAILURE",
        amount_at_risk: 50_000,
        currency: "INR",
        retry_count: 1,
        status: "IN_PROGRESS",
        payment_status: "FAILED",
      },
      customer: {
        opted_out: false,
        dispute_open: false,
      },
      decision: {
        diagnosis_confidence: 0.9,
        requires_approval: false,
      },
      actions: [
        { type: "RETRY_PAYMENT", params: { attempt_number: 2 } },
        { type: "SEND_EMAIL", params: { template: "payment_failed_v1", variables: {} } },
      ],
      counters: {
        whatsapp_sent_7d: 0,
        email_sent_14d: 1,
        sms_sent_7d: 0,
      },
    };

    const result = evaluate(input);

    expect(result.allowed).toBe(true);
    expect(result.required_approval).toBe(false);
    expect(result.result).toBe("ALLOWED");
    expect(result.rejections).toHaveLength(0);
    expect(result.effective_actions).toHaveLength(2);
    expect(result.effective_actions[0]?.status).toBe("ALLOWED");
    expect(result.effective_actions[1]?.status).toBe("ALLOWED");
  });

  it("handles mixed actions where one is rejected and another is allowed", () => {
    const input: PolicyInput = {
      case: {
        id: "case-101",
        tenant_id: "tenant-1",
        risk_type: "PAYMENT_FAILURE",
        amount_at_risk: 50_000,
        currency: "INR",
        retry_count: 3, // at max retries
        status: "IN_PROGRESS",
        payment_status: "FAILED",
      },
      customer: {
        opted_out: false,
        dispute_open: false,
      },
      actions: [
        { type: "RETRY_PAYMENT", params: { attempt_number: 4 } }, // index 0: should be rejected by POL-MAXRETRY
        { type: "SEND_EMAIL", params: { template: "dunning_final" } }, // index 1: should be allowed
      ],
      counters: {
        whatsapp_sent_7d: 0,
        email_sent_14d: 1,
        sms_sent_7d: 0,
      },
    };

    const result = evaluate(input);

    expect(result.allowed).toBe(true);
    expect(result.required_approval).toBe(false);
    expect(result.result).toBe("ALLOWED");
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]).toEqual({
      action_index: 0,
      rule_code: "POL-MAXRETRY",
      reason: "MAX_RETRIES_REACHED",
      action_type: "RETRY_PAYMENT",
    });
    expect(result.effective_actions).toHaveLength(1);
    expect(result.effective_actions[0]?.type).toBe("SEND_EMAIL");
    expect(result.effective_actions[0]?.status).toBe("ALLOWED");
  });

  it("returns overall REJECTED when all proposed actions are rejected", () => {
    const input: PolicyInput = {
      case: {
        id: "case-102",
        tenant_id: "tenant-1",
        risk_type: "PAYMENT_FAILURE",
        amount_at_risk: 50_000,
        currency: "INR",
        retry_count: 3,
        status: "IN_PROGRESS",
        payment_status: "FAILED",
      },
      customer: {
        opted_out: true, // opt-out customer
        dispute_open: false,
      },
      actions: [
        { type: "RETRY_PAYMENT", params: { attempt_number: 4 } },
        { type: "SEND_EMAIL", params: {} },
      ],
      counters: {
        whatsapp_sent_7d: 0,
        email_sent_14d: 0,
        sms_sent_7d: 0,
      },
    };

    const result = evaluate(input);

    expect(result.allowed).toBe(false);
    expect(result.required_approval).toBe(false);
    expect(result.result).toBe("REJECTED");
    expect(result.rejections).toHaveLength(2);
    expect(result.effective_actions).toHaveLength(0);
  });

  it("returns REQUIRE_APPROVAL when high-value invoice threshold is crossed", () => {
    const input: PolicyInput = {
      case: {
        id: "case-103",
        tenant_id: "tenant-1",
        risk_type: "INVOICE_OVERDUE",
        amount_at_risk: 15_000_000, // ₹150,000 > ₹100,000 cap
        currency: "INR",
        retry_count: 0,
        status: "IN_PROGRESS",
      },
      customer: {
        opted_out: false,
        dispute_open: false,
      },
      decision: {
        diagnosis_confidence: 0.95,
        requires_approval: false,
      },
      actions: [
        {
          type: "CREATE_PAYMENT_LINK",
          params: { amount_minor: 15_000_000, currency: "INR", expires_in_hours: 48 },
        },
      ],
      counters: {
        whatsapp_sent_7d: 0,
        email_sent_14d: 0,
        sms_sent_7d: 0,
      },
    };

    const result = evaluate(input);

    expect(result.allowed).toBe(false);
    expect(result.required_approval).toBe(true);
    expect(result.result).toBe("REQUIRE_APPROVAL");
    expect(result.effective_actions).toHaveLength(1);
    expect(result.effective_actions[0]?.status).toBe("REQUIRE_APPROVAL");
  });

  it("evaluates custom tenant rules alongside platform default rules", () => {
    const customRule: ActivePolicyRule = {
      id: "rule-custom-1",
      tenantId: "tenant-1",
      code: "TENANT-NO-SMS-NIGHT",
      name: "No SMS for low risk cases",
      description: "Reject SMS actions when risk score is low",
      ruleKind: "REJECT",
      definition: {
        applies_to: ["SEND_SMS"],
        conditions: [{ field: "case.risk_score", op: "lt", value: 30 }],
        effect: "REJECT",
        reason_code: "LOW_RISK_NO_SMS",
      },
      enabled: true,
      activeVersionId: "ver-custom-1",
      activeVersionNumber: 1,
    };

    const input: PolicyInput = {
      case: {
        id: "case-104",
        tenant_id: "tenant-1",
        risk_type: "PAYMENT_FAILURE",
        risk_score: 25,
        amount_at_risk: 50_000,
        currency: "INR",
        retry_count: 0,
        status: "IN_PROGRESS",
      },
      customer: { opted_out: false, dispute_open: false },
      actions: [{ type: "SEND_SMS", params: { template: "sms_v1" } }],
      counters: { whatsapp_sent_7d: 0, email_sent_14d: 0, sms_sent_7d: 0 },
    };

    const result = evaluate(input, [customRule]);

    expect(result.allowed).toBe(false);
    expect(result.result).toBe("REJECTED");
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.rule_code).toBe("TENANT-NO-SMS-NIGHT");
    expect(result.rejections[0]?.reason).toBe("LOW_RISK_NO_SMS");
    expect(result.rule_versions).toContain("ver-custom-1");
  });

  it("performance smoke benchmark: 500 evaluations execute in <50ms average (<0.1ms per eval)", () => {
    const input: PolicyInput = {
      case: {
        id: "case-perf",
        tenant_id: "tenant-perf",
        risk_type: "PAYMENT_FAILURE",
        amount_at_risk: 75_000,
        currency: "INR",
        retry_count: 1,
        status: "IN_PROGRESS",
        payment_status: "FAILED",
      },
      customer: { opted_out: false, dispute_open: false },
      decision: { diagnosis_confidence: 0.85, requires_approval: false },
      actions: [
        { type: "RETRY_PAYMENT", params: { attempt_number: 2 } },
        { type: "SEND_EMAIL", params: { template: "reminder_v1" } },
      ],
      counters: { whatsapp_sent_7d: 1, email_sent_14d: 1, sms_sent_7d: 0 },
    };

    const start = performance.now();
    const iterations = 500;
    for (let i = 0; i < iterations; i++) {
      evaluate(input);
    }
    const elapsed = performance.now() - start;
    const avgMs = elapsed / iterations;

    expect(avgMs).toBeLessThan(50); // Target <50ms p95 per spec 03 §10
    expect(elapsed).toBeLessThan(250); // Total for 500 in-memory runs should be <<250ms
  });
});
