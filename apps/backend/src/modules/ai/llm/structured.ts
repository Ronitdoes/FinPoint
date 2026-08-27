import { LlmClient, type ChatMessage } from "./client";
import { getDecisionJsonSchema } from "../schemas/decision";
import type { PromptDefinition, DecisionPromptSnapshot } from "../prompts/registry";
import {
  computeCostMinorUnits,
  parseTokenUsage,
} from "../governance/pricing";

export interface StructuredDecisionResult {
  parsedJson: unknown;
  rawText: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costMinorUnits: bigint;
  model: string;
}

export class StructuredCompletionService {
  private readonly client: LlmClient;

  constructor(client: LlmClient) {
    this.client = client;
  }

  /**
   * Generates a structured decision completion conforming strictly to the decision JSON schema.
   */
  public async generateDecision(options: {
    prompt: PromptDefinition;
    snapshot: DecisionPromptSnapshot;
    model?: string;
    customFetch?: typeof fetch;
  }): Promise<StructuredDecisionResult> {
    const { prompt, snapshot, model, customFetch } = options;

    const messages: ChatMessage[] = [
      { role: "system", content: prompt.systemPrompt },
      { role: "user", content: prompt.buildUserPrompt(snapshot) },
    ];

    const jsonSchema = getDecisionJsonSchema();

    const startTime = Date.now();
    const response = await this.client.createChatCompletion(
      {
        model,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "revenue_recovery_decision",
            strict: true,
            schema: jsonSchema,
          },
        },
        temperature: 0.2,
        max_tokens: 800,
      },
      customFetch,
    );

    const latencyMs = Date.now() - startTime;
    const choice = response.choices[0];
    const rawText = choice?.message?.content || "{}";

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      parsedJson = null;
    }

    const tokenUsage = parseTokenUsage(response.usage);
    const resolvedModel = response.model || model || "gpt-4o";
    const costMinorUnits = computeCostMinorUnits(tokenUsage, resolvedModel);

    return {
      parsedJson,
      rawText,
      latencyMs,
      inputTokens: tokenUsage.promptTokens,
      outputTokens: tokenUsage.completionTokens,
      costMinorUnits,
      model: resolvedModel,
    };
  }

  /**
   * Generates a repair completion (N=1) passing previous invalid output and validation error details.
   */
  public async repairDecision(options: {
    prompt: PromptDefinition;
    snapshot: DecisionPromptSnapshot;
    previousOutput: string;
    validationErrors: string;
    model?: string;
    customFetch?: typeof fetch;
  }): Promise<StructuredDecisionResult> {
    const {
      prompt,
      snapshot,
      previousOutput,
      validationErrors,
      model,
      customFetch,
    } = options;

    const repairInstruction = `Your previous output had the following validation errors:
${validationErrors}

PREVIOUS INVALID OUTPUT:
${previousOutput}

Please fix the errors and output a valid JSON decision matching the required schema and allowed action subset for this case type.`;

    const messages: ChatMessage[] = [
      { role: "system", content: prompt.systemPrompt },
      { role: "user", content: prompt.buildUserPrompt(snapshot) },
      { role: "assistant", content: previousOutput },
      { role: "user", content: repairInstruction },
    ];

    const jsonSchema = getDecisionJsonSchema();

    const startTime = Date.now();
    const response = await this.client.createChatCompletion(
      {
        model,
        messages,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "revenue_recovery_decision",
            strict: true,
            schema: jsonSchema,
          },
        },
        temperature: 0.1,
        max_tokens: 800,
      },
      customFetch,
    );

    const latencyMs = Date.now() - startTime;
    const choice = response.choices[0];
    const rawText = choice?.message?.content || "{}";

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      parsedJson = null;
    }

    const tokenUsage = parseTokenUsage(response.usage);
    const resolvedModel = response.model || model || "gpt-4o";
    const costMinorUnits = computeCostMinorUnits(tokenUsage, resolvedModel);

    return {
      parsedJson,
      rawText,
      latencyMs,
      inputTokens: tokenUsage.promptTokens,
      outputTokens: tokenUsage.completionTokens,
      costMinorUnits,
      model: resolvedModel,
    };
  }
}
