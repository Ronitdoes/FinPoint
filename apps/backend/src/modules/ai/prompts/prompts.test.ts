import { describe, it, expect } from "vitest";
import {
  getPrompt,
  listPromptDefinitions,
  UnknownPromptSurfaceError,
} from "./registry";
import { AI_DECIDABLE_ACTIONS } from "@repo/domain";

describe("Prompt Registry & Versioning (Step 14)", () => {
  it("registers v1 prompts for all three core surfaces", () => {
    const definitions = listPromptDefinitions();
    expect(definitions).toHaveLength(3);

    const paymentFailurePrompt = getPrompt("PAYMENT_FAILURE");
    expect(paymentFailurePrompt.id).toBe("payment_failure");
    expect(paymentFailurePrompt.version).toBe("payment_failure@1");
    expect(paymentFailurePrompt.hash).toMatch(/^[a-f0-9]{64}$/);

    const checkoutPrompt = getPrompt("CHECKOUT_ABANDONMENT");
    expect(checkoutPrompt.id).toBe("checkout_abandonment");
    expect(checkoutPrompt.version).toBe("checkout_abandonment@1");
    expect(checkoutPrompt.hash).toMatch(/^[a-f0-9]{64}$/);

    const invoicePrompt = getPrompt("INVOICE_OVERDUE");
    expect(invoicePrompt.id).toBe("invoice_overdue");
    expect(invoicePrompt.version).toBe("invoice_overdue@1");
    expect(invoicePrompt.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("enforces the 5 system prompt invariants across all prompt definitions", () => {
    const definitions = listPromptDefinitions();
    for (const def of definitions) {
      expect(def.systemPrompt).toContain(
        "You are a revenue recovery analyst. You RECOMMEND; you cannot execute anything.",
      );
      expect(def.systemPrompt).toContain(
        "Choose only actions from the provided ALLOWED_ACTIONS list",
      );
      expect(def.systemPrompt).toContain(
        "Prefer zero-cost interventions before incentives",
      );
      expect(def.systemPrompt).toContain(
        "If evidence is insufficient",
      );
      expect(def.systemPrompt).toContain(
        "Never invent identifiers, templates, or fields outside the schema",
      );
    }
  });

  it("embeds surface-specific AI_DECIDABLE_ACTIONS allowlist in each definition", () => {
    const paymentPrompt = getPrompt("PAYMENT_FAILURE");
    expect(paymentPrompt.allowedActions).toEqual(AI_DECIDABLE_ACTIONS.PAYMENT_FAILURE);

    const checkoutPrompt = getPrompt("CHECKOUT_ABANDONMENT");
    expect(checkoutPrompt.allowedActions).toEqual(AI_DECIDABLE_ACTIONS.CHECKOUT_ABANDONMENT);

    const invoicePrompt = getPrompt("INVOICE_OVERDUE");
    expect(invoicePrompt.allowedActions).toEqual(AI_DECIDABLE_ACTIONS.INVOICE_OVERDUE);
  });

  it("formats user prompt snapshot correctly with recovery case, risk, and context", () => {
    const prompt = getPrompt("PAYMENT_FAILURE");
    const snapshot = {
      recovery_case: { id: "rc_1", risk_type: "PAYMENT_FAILURE", amount: 12999 },
      risk: { score: 85, band: "HIGH" },
      customer_context: { customer: { email_masked: "u***@d***.com" } },
    };

    const userPrompt = prompt.buildUserPrompt(snapshot);
    expect(userPrompt).toContain("RECOVERY CASE");
    expect(userPrompt).toContain("RISK EVALUATION");
    expect(userPrompt).toContain("CUSTOMER CONTEXT");
    expect(userPrompt).toContain("u***@d***.com");
  });

  it("throws UnknownPromptSurfaceError for unsupported surface names", () => {
    expect(() => getPrompt("UNSUPPORTED_SURFACE")).toThrow(UnknownPromptSurfaceError);
  });
});
