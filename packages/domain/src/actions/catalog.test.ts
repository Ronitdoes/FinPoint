import { describe, expect, it } from "vitest";

import {
  ACTION_TYPES,
  type ActionType,
} from "../enums/action-type";
import { RISK_TYPES } from "../enums/risk-type";
import { MAX_AUTO_DISCOUNT_MINOR } from "../policy/limits";
import {
  AI_DECIDABLE_ACTIONS,
  UnknownActionTypeError,
  actionParameterSchema,
  aiDecidableActions,
  cataloguedActionSchema,
  tryValidateCatalogAction,
  validateActionParameters,
} from "./catalog";

function validParams(): Record<ActionType, Record<string, unknown>> {
  return {
    RETRY_PAYMENT: { attempt_number: 1 },
    CREATE_PAYMENT_LINK: {
      amount_minor: 250000,
      currency: "INR",
      expires_in_hours: 24,
    },
    SEND_EMAIL: { template: "payment_failed_v1", variables: { name: "Asha" } },
    SEND_WHATSAPP: {
      template: "payment_failed_wa_v1",
      variables: { amount: 2500 },
      language: "en",
    },
    SEND_SMS: { template: "invoice_overdue_sms_v1", variables: {} },
    OFFER_INCENTIVE: { kind: "DISCOUNT", amount_minor: 10000 },
    REQUEST_PAYMENT_METHOD_UPDATE: {},
    CREATE_PROMISE_TO_PAY: {
      promised_amount_minor: 200000,
      promised_by_date: "2026-09-01",
    },
    CREATE_HUMAN_TASK: {
      task_type: "REVIEW",
      title: "Check disputed invoice",
      description: "Tenant flagged a dispute",
      priority: "HIGH",
    },
    PAUSE_CASE: { reason: "awaiting customer response" },
    STOP_CASE: { reason: "payment succeeded" },
  };
}

describe("action parameter validation", () => {
  it("accepts a representative parameter set for every catalog entry", () => {
    const params = validParams();
    for (const type of ACTION_TYPES) {
      expect(() => validateActionParameters(type, params[type])).not.toThrow();
    }
  });

  it("rejects attempt_number < 1", () => {
    expect(() =>
      validateActionParameters("RETRY_PAYMENT", { attempt_number: 0 }),
    ).toThrow();
    expect(() =>
      validateActionParameters("RETRY_PAYMENT", { attempt_number: -1 }),
    ).toThrow();
  });

  it("rejects non-positive or fractional link amounts", () => {
    expect(() =>
      validateActionParameters("CREATE_PAYMENT_LINK", {
        amount_minor: 0,
        currency: "INR",
        expires_in_hours: 24,
      }),
    ).toThrow();
    expect(() =>
      validateActionParameters("CREATE_PAYMENT_LINK", {
        amount_minor: 10.5,
        currency: "INR",
        expires_in_hours: 24,
      }),
    ).toThrow();
  });

  it("rejects incentives above the auto-discount cap (policy limit defense)", () => {
    const params = { kind: "DISCOUNT", amount_minor: MAX_AUTO_DISCOUNT_MINOR + 1 };
    expect(() => validateActionParameters("OFFER_INCENTIVE", params)).toThrow();
    expect(
      validateActionParameters("OFFER_INCENTIVE", {
        kind: "COUPON",
        amount_minor: MAX_AUTO_DISCOUNT_MINOR,
      }).amount_minor,
    ).toBe(MAX_AUTO_DISCOUNT_MINOR);
    expect(() =>
      validateActionParameters("OFFER_INCENTIVE", {
        kind: "GIFT_CARD",
        amount_minor: 1,
      }),
    ).toThrow();
  });

  it("rejects messaging templates without template names or bad variable types", () => {
    expect(() => validateActionParameters("SEND_WHATSAPP", { variables: {} })).toThrow();
    expect(() =>
      validateActionParameters("SEND_EMAIL", {
        template: "t1",
        variables: { nested: { bad: true } },
      }),
    ).toThrow();
  });

  it("rejects invalid promise dates and human-task priorities", () => {
    expect(() =>
      validateActionParameters("CREATE_PROMISE_TO_PAY", {
        promised_amount_minor: 1,
        promised_by_date: "01-09-2026",
      }),
    ).toThrow();
    expect(() =>
      validateActionParameters("CREATE_HUMAN_TASK", {
        task_type: "CALL",
        title: "Call customer",
        description: "",
        priority: "INVALID_PRIORITY",
      }),
    ).toThrow();
  });

  it("requires a reason for pause/stop", () => {
    expect(() => validateActionParameters("PAUSE_CASE", {})).toThrow();
    expect(() => validateActionParameters("STOP_CASE", { reason: "" })).toThrow();
  });
});

describe("closed catalog enforcement", () => {
  it("throws UnknownActionTypeError at runtime for unknown action names", () => {
    expect(() => tryValidateCatalogAction("WIPE_DATABASE", {})).toThrow(
      UnknownActionTypeError,
    );
    expect(() => tryValidateCatalogAction("retry_payment", {})).toThrow(
      UnknownActionTypeError,
    );
    try {
      tryValidateCatalogAction("ARBITRARY_TOOL_NAME", {});
      expect.fail("unknown action must not validate");
    } catch (error) {
      if (error instanceof Error && error.message.includes("must not")) throw error;
      expect((error as UnknownActionTypeError).code).toBe("UNKNOWN_ACTION_TYPE");
    }
  });

  it("rejects unknown types through the discriminated union too", () => {
    const result = cataloguedActionSchema.safeParse({ type: "NOPE" });
    expect(result.success).toBe(false);
    const known = cataloguedActionSchema.safeParse({
      type: "RETRY_PAYMENT",
      attempt_number: 2,
    });
    expect(known.success).toBe(true);
  });

  it("rejects valid types carrying invalid parameters", () => {
    const result = cataloguedActionSchema.safeParse({
      type: "OFFER_INCENTIVE",
      kind: "DISCOUNT",
      amount_minor: MAX_AUTO_DISCOUNT_MINOR * 10,
    });
    expect(result.success).toBe(false);
  });

  it("exposes per-action schemas via actionParameterSchema", () => {
    const schema = actionParameterSchema("CREATE_PROMISE_TO_PAY");
    expect(schema.safeParse({
      promised_amount_minor: 5,
      promised_by_date: "2026-12-31",
    }).success).toBe(true);
  });
});

describe("AI-decidable subsets", () => {
  it("matches the s-03 surface allowlists exactly", () => {
    expect([...AI_DECIDABLE_ACTIONS.PAYMENT_FAILURE]).toEqual([
      "RETRY_PAYMENT",
      "CREATE_PAYMENT_LINK",
      "SEND_WHATSAPP",
      "SEND_EMAIL",
      "REQUEST_PAYMENT_METHOD_UPDATE",
      "CREATE_HUMAN_TASK",
      "STOP_CASE",
    ]);
    expect([...AI_DECIDABLE_ACTIONS.CHECKOUT_ABANDONMENT]).toEqual([
      "SEND_EMAIL",
      "SEND_WHATSAPP",
      "OFFER_INCENTIVE",
      "CREATE_HUMAN_TASK",
      "STOP_CASE",
    ]);
    expect([...AI_DECIDABLE_ACTIONS.INVOICE_OVERDUE]).toEqual([
      "SEND_EMAIL",
      "SEND_WHATSAPP",
      "CREATE_PAYMENT_LINK",
      "OFFER_INCENTIVE",
      "CREATE_PROMISE_TO_PAY",
      "CREATE_HUMAN_TASK",
      "STOP_CASE",
    ]);
  });

  it("covers every risk surface and stays inside the closed catalog", () => {
    expect(Object.keys(AI_DECIDABLE_ACTIONS).sort()).toEqual(
      [...RISK_TYPES].sort(),
    );
    for (const riskType of RISK_TYPES) {
      for (const type of aiDecidableActions(riskType)) {
        expect(ACTION_TYPES).toContain(type);
      }
    }
  });
});
