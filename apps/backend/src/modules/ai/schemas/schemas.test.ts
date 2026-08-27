import { describe, it, expect } from "vitest";
import {
  DecisionRecordSchema,
  getDecisionJsonSchema,
} from "./decision";

describe("Decision Schema & JSON Schema Export (Step 14)", () => {
  it("accepts the Spec 03 §5 example payload verbatim", () => {
    const specExample = {
      diagnosis: {
        cause: "insufficient_funds",
        confidence: 0.91,
        rationale: "Card decline telemetry indicates temporary balance deficiency.",
      },
      actions: [
        {
          type: "RETRY_PAYMENT",
          delay_hours: 24,
          rationale: "Retry payment after standard 24h banking cycle.",
        },
      ],
      stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT", "MAX_RETRIES"],
    };

    const parsed = DecisionRecordSchema.parse(specExample);
    expect(parsed.diagnosis.cause).toBe("insufficient_funds");
    expect(parsed.diagnosis.confidence).toBe(0.91);
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0].type).toBe("RETRY_PAYMENT");
    expect(parsed.stop_conditions).toEqual([
      "PAYMENT_SUCCEEDED",
      "OPTED_OUT",
      "MAX_RETRIES",
    ]);
  });

  it("rejects schemas with missing required properties", () => {
    expect(() => DecisionRecordSchema.parse({})).toThrow();
    expect(() =>
      DecisionRecordSchema.parse({
        diagnosis: { cause: "insufficient_funds", confidence: 0.9, rationale: "test" },
      }),
    ).toThrow();
  });

  it("rejects schemas with invalid cause or confidence out of bounds", () => {
    expect(() =>
      DecisionRecordSchema.parse({
        diagnosis: {
          cause: "invalid_unrecognized_cause",
          confidence: 0.9,
          rationale: "test",
        },
        actions: [{ type: "RETRY_PAYMENT" }],
        stop_conditions: ["PAYMENT_SUCCEEDED"],
      }),
    ).toThrow();

    expect(() =>
      DecisionRecordSchema.parse({
        diagnosis: {
          cause: "insufficient_funds",
          confidence: 1.5, // > 1.0
          rationale: "test",
        },
        actions: [{ type: "RETRY_PAYMENT" }],
        stop_conditions: ["PAYMENT_SUCCEEDED"],
      }),
    ).toThrow();

    expect(() =>
      DecisionRecordSchema.parse({
        diagnosis: {
          cause: "insufficient_funds",
          confidence: -0.1, // < 0.0
          rationale: "test",
        },
        actions: [{ type: "RETRY_PAYMENT" }],
        stop_conditions: ["PAYMENT_SUCCEEDED"],
      }),
    ).toThrow();
  });

  it("rejects empty actions or actions array exceeding 3 items", () => {
    expect(() =>
      DecisionRecordSchema.parse({
        diagnosis: { cause: "insufficient_funds", confidence: 0.9, rationale: "test" },
        actions: [], // empty
        stop_conditions: ["PAYMENT_SUCCEEDED"],
      }),
    ).toThrow();

    expect(() =>
      DecisionRecordSchema.parse({
        diagnosis: { cause: "insufficient_funds", confidence: 0.9, rationale: "test" },
        actions: [
          { type: "RETRY_PAYMENT" },
          { type: "SEND_WHATSAPP" },
          { type: "SEND_EMAIL" },
          { type: "CREATE_HUMAN_TASK" }, // 4 items
        ],
        stop_conditions: ["PAYMENT_SUCCEEDED"],
      }),
    ).toThrow();
  });

  it("generates a valid JSON Schema definition matching OpenAI strict structured output rules", () => {
    const jsonSchema = getDecisionJsonSchema();
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(jsonSchema.required).toEqual(["diagnosis", "actions", "stop_conditions"]);
    expect(jsonSchema.properties).toBeDefined();
  });
});
