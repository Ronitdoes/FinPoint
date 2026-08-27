import { ConfigurationError } from "../../../lib/errors";

export interface ModelPricing {
  readonly input_per_1k_minor: number; // paise / minor units per 1,000 input tokens
  readonly output_per_1k_minor: number; // paise / minor units per 1,000 output tokens
}

/**
 * Authoritative Model Token Pricing Table (Spec 00 §9, Spec 02 §8, Step 15).
 * Prices in INR paise (minor units) per 1,000 tokens (assuming ~$1 = ₹85 baseline conversion).
 */
export const MODEL_PRICING_TABLE: Readonly<Record<string, ModelPricing>> = Object.freeze({
  "gpt-4o": { input_per_1k_minor: 21, output_per_1k_minor: 85 },
  "gpt-4o-mini": { input_per_1k_minor: 1, output_per_1k_minor: 5 },
  "gpt-4-turbo": { input_per_1k_minor: 85, output_per_1k_minor: 255 },
  "gpt-3.5-turbo": { input_per_1k_minor: 4, output_per_1k_minor: 13 },
  "claude-3-5-sonnet": { input_per_1k_minor: 25, output_per_1k_minor: 125 },
  "claude-3-haiku": { input_per_1k_minor: 2, output_per_1k_minor: 10 },
  "gemini-1.5-pro": { input_per_1k_minor: 30, output_per_1k_minor: 90 },
  "gemini-1.5-flash": { input_per_1k_minor: 1, output_per_1k_minor: 3 },
  "mock-model": { input_per_1k_minor: 10, output_per_1k_minor: 20 },
});

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Universal token usage parser supporting OpenAI, Anthropic, Gemini, and camelCase provider payloads.
 */
export function parseTokenUsage(rawUsage: unknown): TokenUsage {
  if (!rawUsage || typeof rawUsage !== "object") {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }

  const u = rawUsage as Record<string, any>;

  // 1. Prompt / Input tokens
  const promptTokens = Number(
    u.prompt_tokens ??
      u.input_tokens ??
      u.promptTokens ??
      u.inputTokens ??
      u.promptTokenCount ??
      u.tokens?.input ??
      u.tokens?.prompt ??
      0,
  );

  // 2. Completion / Output tokens
  const completionTokens = Number(
    u.completion_tokens ??
      u.output_tokens ??
      u.completionTokens ??
      u.outputTokens ??
      u.candidatesTokenCount ??
      u.tokens?.output ??
      u.tokens?.completion ??
      0,
  );

  // 3. Total tokens
  const totalTokens = Number(
    u.total_tokens ??
      u.totalTokens ??
      u.totalTokenCount ??
      promptTokens + completionTokens,
  );

  return {
    promptTokens: Number.isFinite(promptTokens) && promptTokens > 0 ? Math.floor(promptTokens) : 0,
    completionTokens:
      Number.isFinite(completionTokens) && completionTokens > 0 ? Math.floor(completionTokens) : 0,
    totalTokens: Number.isFinite(totalTokens) && totalTokens > 0 ? Math.floor(totalTokens) : 0,
  };
}

/**
 * Computes the exact cost in minor units (paise) for token usage with a given model.
 * Supports both (usage, model) and (model, promptTokens, completionTokens) signatures.
 * 
 * Reliability requirement (s-15): Unknown model fails CLOSED (throws ConfigurationError)
 * rather than allowing untracked or free decisions.
 */
export function computeCostMinorUnits(
  usageOrModel:
    | TokenUsage
    | {
        promptTokens?: number;
        completionTokens?: number;
        inputTokens?: number;
        outputTokens?: number;
      }
    | string,
  modelOrPromptTokens?: string | number,
  completionTokensArg?: number,
): bigint {
  let model: string;
  let promptTokens = 0;
  let completionTokens = 0;

  if (typeof usageOrModel === "string") {
    // Called as (model, promptTokens, completionTokens)
    model = usageOrModel;
    promptTokens = typeof modelOrPromptTokens === "number" ? modelOrPromptTokens : 0;
    completionTokens = typeof completionTokensArg === "number" ? completionTokensArg : 0;
  } else {
    // Called as (usage, model)
    model = typeof modelOrPromptTokens === "string" ? modelOrPromptTokens : "gpt-4o";
    promptTokens =
      "promptTokens" in usageOrModel
        ? (usageOrModel.promptTokens ?? 0)
        : "inputTokens" in usageOrModel
          ? (usageOrModel.inputTokens ?? 0)
          : 0;
    completionTokens =
      "completionTokens" in usageOrModel
        ? (usageOrModel.completionTokens ?? 0)
        : "outputTokens" in usageOrModel
          ? (usageOrModel.outputTokens ?? 0)
          : 0;
  }

  const pricing = MODEL_PRICING_TABLE[model];
  if (!pricing) {
    throw new ConfigurationError(
      `Unknown LLM model '${model}' has no configured pricing table entry`,
      { model, supportedModels: Object.keys(MODEL_PRICING_TABLE) },
    );
  }

  if (promptTokens <= 0 && completionTokens <= 0) {
    return 0n;
  }

  const promptCost = Math.ceil((promptTokens * pricing.input_per_1k_minor) / 1000);
  const completionCost = Math.ceil((completionTokens * pricing.output_per_1k_minor) / 1000);

  return BigInt(promptCost + completionCost);
}

export const calculateLlmCostMinorUnits = computeCostMinorUnits;
