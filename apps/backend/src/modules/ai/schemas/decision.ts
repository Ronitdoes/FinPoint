import { z } from "zod";
import { ACTION_TYPES, type ActionType } from "@repo/domain";

export const DIAGNOSIS_CAUSES = [
  "insufficient_funds",
  "stale_card",
  "bank_decline",
  "network_issue",
  "price_objection",
  "distraction",
  "waiting_for_payday",
  "unknown",
] as const;

export type DiagnosisCause = (typeof DIAGNOSIS_CAUSES)[number];

export const STOP_CONDITIONS = [
  "PAYMENT_SUCCEEDED",
  "OPTED_OUT",
  "MAX_RETRIES",
  "CASE_DISPUTED",
  "POLICY_STOP",
  "PROMISE_CREATED",
] as const;

export type StopCondition = (typeof STOP_CONDITIONS)[number];

export const DiagnosisSchema = z.object({
  cause: z.enum(DIAGNOSIS_CAUSES),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(240),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;

export const DecisionActionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  delay_hours: z.number().int().min(1).max(168).optional(),
  rationale: z.string().max(240).optional(),
  params: z.record(z.unknown()).optional(),
});

export type DecisionAction = z.infer<typeof DecisionActionSchema>;

export const DecisionRecordSchema = z.object({
  diagnosis: DiagnosisSchema,
  actions: z.array(DecisionActionSchema).min(1).max(3),
  stop_conditions: z.array(z.string().min(1)).min(1),
});

export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/**
 * Generates an OpenAI-compatible JSON Schema definition for strict structured output.
 * (Spec 01 §10, Spec 03 §5, ADR-008)
 */
export function getDecisionJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["diagnosis", "actions", "stop_conditions"],
    properties: {
      diagnosis: {
        type: "object",
        additionalProperties: false,
        required: ["cause", "confidence", "rationale"],
        properties: {
          cause: {
            type: "string",
            enum: [...DIAGNOSIS_CAUSES],
            description: "The diagnosed primary cause of revenue risk",
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
            description: "Model confidence score between 0.0 and 1.0",
          },
          rationale: {
            type: "string",
            maxLength: 240,
            description: "Brief diagnostic rationale summary (<= 240 chars)",
          },
        },
      },
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        description: "Ranked list of recommended recovery actions (1 to 3 actions)",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "rationale"],
          properties: {
            type: {
              type: "string",
              enum: [...ACTION_TYPES],
              description: "Action catalog type",
            },
            delay_hours: {
              type: "number",
              minimum: 1,
              maximum: 168,
              description: "Optional execution delay in hours (1-168)",
            },
            rationale: {
              type: "string",
              maxLength: 240,
              description: "Rationale for choosing this action",
            },
            params: {
              type: "object",
              additionalProperties: true,
              description: "Structured parameters specific to the action type",
            },
          },
        },
      },
      stop_conditions: {
        type: "array",
        minItems: 1,
        description: "Conditions under which the recovery workflow must terminate immediately",
        items: {
          type: "string",
          enum: [...STOP_CONDITIONS],
        },
      },
    },
  };
}
