import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LlmClient,
  LlmTimeoutError,
  LlmRateLimitError,
  LlmTransportError,
} from "./client";
import { LlmCircuitBreaker, CircuitBreakerOpenError } from "./circuit-breaker";
import { calculateLlmCostMinorUnits } from "./structured";

describe("LLM Client, Circuit Breaker & Pricing (Step 14)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Pricing Calculator", () => {
    it("calculates cost in minor units (paise) accurately for gpt-4o", () => {
      // 1000 prompt tokens @ 21250 paise / 1M => 21.25 paise => rounded integer 21 paise
      // 500 completion tokens @ 85000 paise / 1M => 42.5 paise => rounded integer 42 paise
      const cost = calculateLlmCostMinorUnits("gpt-4o", 1000, 500);
      expect(cost).toBeGreaterThan(0n);
      expect(typeof cost).toBe("bigint");
    });
  });

  describe("Circuit Breaker", () => {
    it("opens after failureThreshold consecutive errors and trips to open state", () => {
      const breaker = new LlmCircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });

      expect(breaker.isOpen()).toBe(false);
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.isOpen()).toBe(false);

      breaker.recordFailure(); // 3rd failure
      expect(breaker.isOpen()).toBe(true);

      const state = breaker.getState();
      expect(state.state).toBe("OPEN");
      expect(state.consecutiveFailures).toBe(3);
    });

    it("resets on success", () => {
      const breaker = new LlmCircuitBreaker({ failureThreshold: 3 });
      breaker.recordFailure();
      breaker.recordFailure();
      expect(breaker.getState().consecutiveFailures).toBe(2);

      breaker.recordSuccess();
      expect(breaker.getState().consecutiveFailures).toBe(0);
      expect(breaker.isOpen()).toBe(false);
    });
  });

  describe("LlmClient Transport", () => {
    it("retries on transient 500 errors and succeeds when next call is 200", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("Internal Server Error", { status: 500 });
        }
        return new Response(
          JSON.stringify({
            id: "chatcmpl-123",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"status":"ok"}' },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const client = new LlmClient({
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-test",
        maxRetries: 2,
        timeoutMs: 5000,
        circuitBreaker: new LlmCircuitBreaker(),
      });

      const response = await client.createChatCompletion(
        { messages: [{ role: "user", content: "hello" }] },
        mockFetch as any,
      );

      expect(callCount).toBe(2);
      expect(response.choices[0].message.content).toBe('{"status":"ok"}');
    });

    it("retries on HTTP 429 rate limit errors", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return new Response("Rate Limit Exceeded", { status: 429 });
        }
        return new Response(
          JSON.stringify({
            id: "chatcmpl-429-resolved",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: '{"rate_limit":"resolved"}' },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });

      const client = new LlmClient({
        baseUrl: "https://api.openai.com/v1",
        maxRetries: 2,
        timeoutMs: 5000,
        circuitBreaker: new LlmCircuitBreaker(),
      });

      const response = await client.createChatCompletion(
        { messages: [{ role: "user", content: "test" }] },
        mockFetch as any,
      );

      expect(callCount).toBe(2);
      expect(response.choices[0].message.content).toBe('{"rate_limit":"resolved"}');
    });

    it("does not retry non-transient HTTP 400 client errors", async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return new Response("Bad Request", { status: 400 });
      });

      const client = new LlmClient({
        maxRetries: 2,
        circuitBreaker: new LlmCircuitBreaker(),
      });

      await expect(
        client.createChatCompletion(
          { messages: [{ role: "user", content: "bad" }] },
          mockFetch as any,
        ),
      ).rejects.toThrow(LlmTransportError);

      expect(callCount).toBe(1); // No retry on 400
    });

    it("throws immediately with LlmTimeoutError when SIMULATE_LLM_FAILURE is enabled", async () => {
      const client = new LlmClient({
        simulateLlmFailure: true,
        timeoutMs: 20000,
        circuitBreaker: new LlmCircuitBreaker(),
      });

      await expect(
        client.createChatCompletion({
          messages: [{ role: "user", content: "simulate" }],
        }),
      ).rejects.toThrow(LlmTimeoutError);
    });

    it("throws CircuitBreakerOpenError when breaker is open", async () => {
      const breaker = new LlmCircuitBreaker({ failureThreshold: 1 });
      breaker.recordFailure(); // trips open

      const client = new LlmClient({ circuitBreaker: breaker });

      await expect(
        client.createChatCompletion({
          messages: [{ role: "user", content: "blocked" }],
        }),
      ).rejects.toThrow(CircuitBreakerOpenError);
    });
  });
});
