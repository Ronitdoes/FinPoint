import {
  DecisionRecordSchema,
  type DecisionRecord,
} from "../schemas/decision";

export interface StructuralValidationResult {
  valid: boolean;
  data: DecisionRecord | null;
  errors: string[];
}

/**
 * Performs strict structural JSON validation against the Zod DecisionRecordSchema.
 */
export function validateStructural(raw: unknown): StructuralValidationResult {
  if (!raw || typeof raw !== "object") {
    return {
      valid: false,
      data: null,
      errors: ["Output must be a non-null JSON object"],
    };
  }

  const parseResult = DecisionRecordSchema.safeParse(raw);
  if (!parseResult.success) {
    const errorMessages = parseResult.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    return {
      valid: false,
      data: null,
      errors: errorMessages,
    };
  }

  return {
    valid: true,
    data: parseResult.data,
    errors: [],
  };
}
