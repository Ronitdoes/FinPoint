import { getLogger } from "@repo/observability";
import { defaultCircuitBreaker, LlmCircuitBreaker, CircuitBreakerOpenError } from "./circuit-breaker";

const logger = getLogger({ component: "llm-client" });

export interface LlmClientConfig {
  baseUrl?: string | null;
  apiKey?: string | null;
  model?: string;
  timeoutMs?: number; // default: 20000 (20s)
  maxRetries?: number; // default: 2
  simulateLlmFailure?: boolean;
  circuitBreaker?: LlmCircuitBreaker;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  response_format?: {
    type: "json_schema";
    json_schema: {
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
  };
  temperature?: number;
  max_tokens?: number;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: ChatCompletionUsage;
}

export class LlmTransportError extends Error {
  readonly statusCode?: number;
  readonly isTransient: boolean;

  constructor(
    message: string,
    options: { statusCode?: number; isTransient?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "LlmTransportError";
    this.statusCode = options.statusCode;
    this.isTransient = options.isTransient ?? false;
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

export class LlmTimeoutError extends LlmTransportError {
  constructor(timeoutMs: number) {
    super(`LLM request timed out after ${timeoutMs}ms`, {
      statusCode: 504,
      isTransient: true,
    });
    this.name = "LlmTimeoutError";
  }
}

export class LlmRateLimitError extends LlmTransportError {
  constructor(message: string = "LLM rate limit reached (429)") {
    super(message, { statusCode: 429, isTransient: true });
    this.name = "LlmRateLimitError";
  }
}

export class LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly simulateLlmFailure: boolean;
  private readonly circuitBreaker: LlmCircuitBreaker;

  constructor(config: LlmClientConfig = {}) {
    this.baseUrl = (config.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? null;
    this.defaultModel = config.model || "gpt-4o";
    this.timeoutMs = config.timeoutMs ?? 20000;
    this.maxRetries = config.maxRetries ?? 2;
    this.simulateLlmFailure = config.simulateLlmFailure ?? false;
    this.circuitBreaker = config.circuitBreaker ?? defaultCircuitBreaker;
  }

  public getCircuitBreaker(): LlmCircuitBreaker {
    return this.circuitBreaker;
  }

  /**
   * Dispatches a structured chat completion request with timeout, retries, and circuit breaker.
   */
  public async createChatCompletion(
    request: ChatCompletionRequest,
    customFetch?: typeof fetch,
  ): Promise<ChatCompletionResponse> {
    if (this.circuitBreaker.isOpen()) {
      throw new CircuitBreakerOpenError();
    }

    if (this.simulateLlmFailure) {
      logger.warn("SIMULATE_LLM_FAILURE flag is active; triggering simulated timeout");
      this.circuitBreaker.recordFailure();
      throw new LlmTimeoutError(this.timeoutMs);
    }

    return await this.circuitBreaker.execute(async () => {
      let lastError: unknown;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (attempt > 0) {
          const backoff = this.calculateBackoffMs(attempt);
          logger.info({ attempt, backoff }, "Retrying transient LLM call");
          await this.sleep(backoff);
        }

        try {
          return await this.executeSingleRequest(request, customFetch);
        } catch (err: any) {
          lastError = err;
          const isTransient =
            err instanceof LlmTransportError
              ? err.isTransient
              : this.isTransientNetworkError(err);

          if (!isTransient || attempt >= this.maxRetries) {
            throw err;
          }
        }
      }

      throw lastError;
    });
  }

  private async executeSingleRequest(
    request: ChatCompletionRequest,
    customFetch?: typeof fetch,
  ): Promise<ChatCompletionResponse> {
    const fetchImpl = customFetch || globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const endpoint = `${this.baseUrl}/chat/completions`;
    const payload = {
      model: request.model || this.defaultModel,
      messages: request.messages,
      response_format: request.response_format,
      temperature: request.temperature ?? 0.2,
      max_tokens: request.max_tokens ?? 800,
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const status = response.status;

        if (status === 429) {
          throw new LlmRateLimitError(`LLM rate limited (429): ${errorText}`);
        }

        const isTransient = status >= 500 && status <= 599;
        throw new LlmTransportError(
          `LLM API returned HTTP ${status}: ${errorText}`,
          { statusCode: status, isTransient },
        );
      }

      const json = (await response.json()) as ChatCompletionResponse;
      return json;
    } catch (err: any) {
      if (err.name === "AbortError" || controller.signal.aborted) {
        throw new LlmTimeoutError(this.timeoutMs);
      }
      if (err instanceof LlmTransportError) {
        throw err;
      }
      throw new LlmTransportError(`LLM network fetch failed: ${err.message}`, {
        isTransient: true,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private calculateBackoffMs(attempt: number): number {
    const base = 200; // 200ms
    const max = 2000; // 2s
    const exponential = Math.min(max, base * Math.pow(2, attempt));
    const jitter = Math.floor(Math.random() * 100);
    return exponential + jitter;
  }

  private isTransientNetworkError(err: any): boolean {
    if (err?.name === "AbortError") return true;
    if (err?.code === "ECONNRESET" || err?.code === "ETIMEDOUT") return true;
    if (err?.message?.includes("fetch failed")) return true;
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
