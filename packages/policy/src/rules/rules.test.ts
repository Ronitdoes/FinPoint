import { describe, expect, it } from "vitest";
import {
  evaluateConfidenceRule,
  evaluateDiscountCapRule,
  evaluateDisputeRule,
  evaluateEmailCapRule,
  evaluateHighValueRule,
  evaluateMaxRetryRule,
  evaluateOptoutRule,
  evaluatePaymentSuccessRule,
  evaluateWhatsAppCapRule,
} from "./index";
import type { NormalizedEvaluationContext } from "../types";

function createContext(overrides: Partial<NormalizedEvaluationContext> = {}): NormalizedEvaluationContext {
  return {
    case: {
      id: "case-1",
      tenant_id: "tenant-1",
      risk_type: "PAYMENT_FAILURE",
      amount_at_risk: 50_000,
      currency: "INR",
      retry_count: 0,
      status: "IN_PROGRESS",
      payment_status: "FAILED",
      ...overrides.case,
    },
    customer: {
      opted_out: false,
      dispute_open: false,
      ...overrides.customer,
    },
    decision: overrides.decision !== undefined ? overrides.decision : {
      diagnosis_confidence: 0.85,
      requires_approval: false,
    },
    counters: {
      whatsapp_sent_7d: 0,
      email_sent_14d: 0,
      sms_sent_7d: 0,
      ...overrides.counters,
    },
    action: {
      type: "SEND_EMAIL",
      params: {},
      ...overrides.action,
    },
    action_index: overrides.action_index ?? 0,
    options: overrides.options || {},
  };
}

describe("Policy Engine Rules Unit Tests (Spec 01 §11, Spec 02 §7, Spec 03 §6)", () => {
  describe("POL-OPTOUT (Customer Opt-out Rule)", () => {
    it.each([
      { actionType: "SEND_EMAIL", optedOut: true, expectedReject: true },
      { actionType: "SEND_WHATSAPP", optedOut: true, expectedReject: true },
      { actionType: "SEND_SMS", optedOut: true, expectedReject: true },
      { actionType: "RETRY_PAYMENT", optedOut: true, expectedReject: false },
      { actionType: "CREATE_PAYMENT_LINK", optedOut: true, expectedReject: false },
      { actionType: "SEND_EMAIL", optedOut: false, expectedReject: false },
    ])("action $actionType with opted_out=$optedOut -> reject=$expectedReject", ({ actionType, optedOut, expectedReject }) => {
      const ctx = createContext({
        customer: { opted_out: optedOut, dispute_open: false },
        action: { type: actionType, params: {} },
      });
      const outcome = evaluateOptoutRule(ctx);
      if (expectedReject) {
        expect(outcome).not.toBeNull();
        expect(outcome?.verdict).toBe("REJECT");
        expect(outcome?.rule_code).toBe("POL-OPTOUT");
        expect(outcome?.reason).toBe("CUSTOMER_OPTED_OUT");
      } else {
        expect(outcome).toBeNull();
      }
    });
  });

  describe("POL-DISPUTE (Open Dispute Rule)", () => {
    it.each([
      { disputeOpen: true, actionType: "RETRY_PAYMENT", expectedReject: true },
      { disputeOpen: true, actionType: "SEND_EMAIL", expectedReject: true },
      { disputeOpen: true, actionType: "OFFER_INCENTIVE", expectedReject: true },
      { disputeOpen: false, actionType: "RETRY_PAYMENT", expectedReject: false },
    ])("dispute_open=$disputeOpen on $actionType -> reject=$expectedReject", ({ disputeOpen, actionType, expectedReject }) => {
      const ctx = createContext({
        customer: { opted_out: false, dispute_open: disputeOpen },
        action: { type: actionType, params: {} },
      });
      const outcome = evaluateDisputeRule(ctx);
      if (expectedReject) {
        expect(outcome).not.toBeNull();
        expect(outcome?.verdict).toBe("REJECT");
        expect(outcome?.rule_code).toBe("POL-DISPUTE");
        expect(outcome?.reason).toBe("DISPUTE_OPEN");
      } else {
        expect(outcome).toBeNull();
      }
    });
  });

  describe("POL-MAXRETRY (Max Payment Retries Cap)", () => {
    it.each([
      { retryCount: 0, expectedReject: false },
      { retryCount: 1, expectedReject: false },
      { retryCount: 2, expectedReject: false },
      { retryCount: 3, expectedReject: true }, // boundary cap = 3
      { retryCount: 4, expectedReject: true },
    ])("retry_count=$retryCount for RETRY_PAYMENT -> reject=$expectedReject", ({ retryCount, expectedReject }) => {
      const ctx = createContext({
        case: { retry_count: retryCount } as any,
        action: { type: "RETRY_PAYMENT", params: { attempt_number: retryCount + 1 } },
      });
      const outcome = evaluateMaxRetryRule(ctx);
      if (expectedReject) {
        expect(outcome).not.toBeNull();
        expect(outcome?.verdict).toBe("REJECT");
        expect(outcome?.rule_code).toBe("POL-MAXRETRY");
        expect(outcome?.reason).toBe("MAX_RETRIES_REACHED");
      } else {
        expect(outcome).toBeNull();
      }
    });

    it("does not reject non-retry actions when retry_count >= 3", () => {
      const ctx = createContext({
        case: { retry_count: 3 } as any,
        action: { type: "SEND_EMAIL", params: {} },
      });
      expect(evaluateMaxRetryRule(ctx)).toBeNull();
    });
  });

  describe("POL-WA-CAP (WhatsApp 7-Day Frequency Cap)", () => {
    it.each([
      { sent7d: 0, expectedReject: false },
      { sent7d: 1, expectedReject: false },
      { sent7d: 2, expectedReject: true }, // cap = 2
      { sent7d: 3, expectedReject: true },
    ])("whatsapp_sent_7d=$sent7d -> reject=$expectedReject", ({ sent7d, expectedReject }) => {
      const ctx = createContext({
        counters: { whatsapp_sent_7d: sent7d, email_sent_14d: 0, sms_sent_7d: 0 },
        action: { type: "SEND_WHATSAPP", params: {} },
      });
      const outcome = evaluateWhatsAppCapRule(ctx);
      if (expectedReject) {
        expect(outcome).not.toBeNull();
        expect(outcome?.verdict).toBe("REJECT");
        expect(outcome?.rule_code).toBe("POL-WA-CAP");
        expect(outcome?.reason).toBe("WHATSAPP_FREQUENCY_CAP_EXCEEDED");
      } else {
        expect(outcome).toBeNull();
      }
    });
  });

  describe("POL-EM-CAP (Email 14-Day Frequency Cap)", () => {
    it.each([
      { sent14d: 0, expectedReject: false },
      { sent14d: 1, expectedReject: false },
      { sent14d: 2, expectedReject: false },
      { sent14d: 3, expectedReject: true }, // cap = 3
      { sent14d: 4, expectedReject: true },
    ])("email_sent_14d=$sent14d -> reject=$expectedReject", ({ sent14d, expectedReject }) => {
      const ctx = createContext({
        counters: { whatsapp_sent_7d: 0, email_sent_14d: sent14d, sms_sent_7d: 0 },
        action: { type: "SEND_EMAIL", params: {} },
      });
      const outcome = evaluateEmailCapRule(ctx);
      if (expectedReject) {
        expect(outcome).not.toBeNull();
        expect(outcome?.verdict).toBe("REJECT");
        expect(outcome?.rule_code).toBe("POL-EM-CAP");
        expect(outcome?.reason).toBe("EMAIL_FREQUENCY_CAP_EXCEEDED");
      } else {
        expect(outcome).toBeNull();
      }
    });
  });

  describe("POL-DISCOUNT (Discount Cap & Clamping)", () => {
    it("allows discount within cap with high confidence", () => {
      const ctx = createContext({
        action: { type: "OFFER_INCENTIVE", params: { kind: "DISCOUNT", amount_minor: 400_000 } },
        decision: { diagnosis_confidence: 0.9, requires_approval: false },
      });
      const outcome = evaluateDiscountCapRule(ctx);
      expect(outcome).toBeNull();
    });

    it("rejects discount exceeding cap when clamping is disabled", () => {
      const ctx = createContext({
        action: { type: "OFFER_INCENTIVE", params: { kind: "DISCOUNT", amount_minor: 600_000 } },
        options: { clamp_to_cap: false },
      });
      const outcome = evaluateDiscountCapRule(ctx);
      expect(outcome).not.toBeNull();
      expect(outcome?.verdict).toBe("REJECT");
      expect(outcome?.rule_code).toBe("POL-DISCOUNT");
      expect(outcome?.reason).toBe("MAX_DISCOUNT_EXCEEDED");
    });

    it("clamps discount exceeding cap to 500,000 minor units when clamping is enabled", () => {
      const ctx = createContext({
        action: { type: "OFFER_INCENTIVE", params: { kind: "DISCOUNT", amount_minor: 750_000 } },
        options: { clamp_to_cap: true },
        decision: { diagnosis_confidence: 0.9, requires_approval: false },
      });
      const outcome = evaluateDiscountCapRule(ctx);
      expect(outcome).not.toBeNull();
      expect(outcome?.verdict).toBe("ADJUST");
      expect(outcome?.adjusted_params?.amount_minor).toBe(500_000);
      expect(outcome?.adjustment_reason).toContain("clamped");
    });

    it("requires approval for discount within cap when confidence < 0.6", () => {
      const ctx = createContext({
        action: { type: "OFFER_INCENTIVE", params: { kind: "DISCOUNT", amount_minor: 300_000 } },
        decision: { diagnosis_confidence: 0.55, requires_approval: false },
      });
      const outcome = evaluateDiscountCapRule(ctx);
      expect(outcome).not.toBeNull();
      expect(outcome?.verdict).toBe("REQUIRE_APPROVAL");
      expect(outcome?.reason).toBe("INCENTIVE_REQUIRES_APPROVAL");
    });
  });

  describe("POL-HIGHVALUE (High Value Approval Threshold)", () => {
    it.each([
      { amount: 10_000_000, actionType: "CREATE_PAYMENT_LINK", expectedApproval: false }, // boundary: <= 100,000 INR
      { amount: 10_000_001, actionType: "CREATE_PAYMENT_LINK", expectedApproval: true },  // > 100,000 INR
      { amount: 25_000_000, actionType: "OFFER_INCENTIVE", expectedApproval: true },
      { amount: 25_000_000, actionType: "SEND_EMAIL", expectedApproval: false },           // non-financial action
    ])("amount=$amount on $actionType -> require_approval=$expectedApproval", ({ amount, actionType, expectedApproval }) => {
      const ctx = createContext({
        case: { amount_at_risk: amount } as any,
        action: { type: actionType, params: {} },
      });
      const outcome = evaluateHighValueRule(ctx);
      if (expectedApproval) {
        expect(outcome).not.toBeNull();
        expect(outcome?.verdict).toBe("REQUIRE_APPROVAL");
        expect(outcome?.rule_code).toBe("POL-HIGHVALUE");
        expect(outcome?.reason).toBe("HIGH_VALUE_THRESHOLD_EXCEEDED");
      } else {
        expect(outcome).toBeNull();
      }
    });
  });

  describe("POL-CONFIDENCE (AI Confidence Threshold Gate)", () => {
    it.each([
      { confidence: 0.8, actionType: "RETRY_PAYMENT", expectedApproval: false },
      { confidence: 0.6, actionType: "RETRY_PAYMENT", expectedApproval: false }, // boundary 0.6
      { confidence: 0.59, actionType: "RETRY_PAYMENT", expectedApproval: true },
      { confidence: 0.50, actionType: "CREATE_PAYMENT_LINK", expectedApproval: true },
      { confidence: 0.50, actionType: "SEND_EMAIL", expectedApproval: false }, // low-stakes action
    ])("confidence=$confidence on $actionType -> require_approval=$expectedApproval", ({ confidence, actionType, expectedApproval }) => {
      const ctx = createContext({
        action: { type: actionType, params: {} },
        decision: { diagnosis_confidence: confidence, requires_approval: false },
      });
      const outcome = evaluateConfidenceRule(ctx);
      if (expectedApproval) {
        expect(outcome).not.toBeNull();
        expect(outcome?.verdict).toBe("REQUIRE_APPROVAL");
        expect(outcome?.rule_code).toBe("POL-CONFIDENCE");
        expect(outcome?.reason).toBe("LOW_CONFIDENCE_REQUIRES_APPROVAL");
      } else {
        expect(outcome).toBeNull();
      }
    });

    it("triggers approval when decision explicitly sets requires_approval=true", () => {
      const ctx = createContext({
        action: { type: "SEND_EMAIL", params: {} },
        decision: { diagnosis_confidence: 0.95, requires_approval: true },
      });
      const outcome = evaluateConfidenceRule(ctx);
      expect(outcome).not.toBeNull();
      expect(outcome?.verdict).toBe("REQUIRE_APPROVAL");
      expect(outcome?.reason).toBe("CONFIDENCE_GATE_TRIGGERED");
    });
  });

  describe("POL-PAYMENT-SUCCESS (Payment Success Stop Rule)", () => {
    it.each([
      { paymentStatus: "SUCCEEDED", caseStatus: "IN_PROGRESS", expectedReject: true },
      { paymentStatus: "FAILED", caseStatus: "SUCCEEDED", expectedReject: true },
      { paymentStatus: "FAILED", caseStatus: "RECOVERED", expectedReject: true },
      { paymentStatus: "FAILED", caseStatus: "RESOLVED_UPSTREAM", expectedReject: true },
      { paymentStatus: "FAILED", caseStatus: "IN_PROGRESS", expectedReject: false },
    ])("paymentStatus=$paymentStatus, caseStatus=$caseStatus -> reject=$expectedReject", ({ paymentStatus, caseStatus, expectedReject }) => {
      const ctx = createContext({
        case: { payment_status: paymentStatus, status: caseStatus } as any,
        action: { type: "SEND_EMAIL", params: {} },
      });
      const outcome = evaluatePaymentSuccessRule(ctx);
      if (expectedReject) {
        expect(outcome).not.toBeNull();
        expect(outcome?.verdict).toBe("REJECT");
        expect(outcome?.rule_code).toBe("POL-PAYMENT-SUCCESS");
        expect(outcome?.reason).toBe("PAYMENT_ALREADY_SUCCEEDED");
      } else {
        expect(outcome).toBeNull();
      }
    });
  });
});
