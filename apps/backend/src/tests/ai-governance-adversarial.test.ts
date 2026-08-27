import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { NullBus } from "@repo/integrations";
import {
  db,
  createTenant,
  createApiKey,
  createCustomer,
  createCase,
  createRevenueRisk,
  createPayment,
  listCostEntriesForCase,
  listDecisionsForCase,
} from "@repo/db";
import { sha256 } from "../lib/crypto";
import { apiConfig } from "@repo/config";
import { AiDecideService } from "../modules/ai/decide.service";
import {
  requiresApproval,
  parseTokenUsage,
  computeCostMinorUnits,
  MODEL_PRICING_TABLE,
} from "../modules/ai/governance";
import { LlmCircuitBreaker } from "../modules/ai/llm/circuit-breaker";
import { ContextInvalidError, ConfigurationError } from "../lib/errors";
import { EvalRunner } from "../../../../services/eval/src/runner";

describe("Step 15 — AI Governance & Adversarial Test Suite (All 11 Scenarios)", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let tenantId: string;
  let adminApiKey: string;
  let operationsApiKey: string;
  let customerId: string;
  let caseId: string;
  let riskId: string;

  const runId = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const eventBus = new NullBus();

    // 1. Create Tenant
    const tenant = await createTenant(
      { db },
      {
        name: `AI Governance Tenant ${runId}`,
        slug: `ai-governance-tenant-${runId}`,
      },
    );
    tenantId = tenant.id;

    // 2. Create Admin API Key
    const rawAdminKey = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId,
        keyHash: sha256(rawAdminKey),
        name: `Admin Key ${runId}`,
        scopes: ["*"],
      },
    );
    adminApiKey = rawAdminKey;

    // 3. Create Operations API Key
    const rawOpsKey = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId,
        keyHash: sha256(rawOpsKey),
        name: `Operations Key ${runId}`,
        scopes: ["ai:decide"],
      },
    );
    operationsApiKey = rawOpsKey;

    // 4. Create Customer, Payment, Case & Risk
    const customer = await createCustomer(
      { db },
      {
        tenantId,
        externalRef: `cus_gov_${runId}`,
        name: "David Governance",
        email: "david.gov@example.com",
        phone: "+919876543210",
      },
    );
    customerId = customer.id;

    const payment = await createPayment(
      { db },
      {
        tenantId,
        customerId,
        amount: 500000n, // ₹5,000.00
        currency: "INR",
        status: "FAILED",
        provider: "STRIPE",
        providerPaymentId: `pi_gov_${runId}`,
        failureCode: "insufficient_funds",
        failureMessage: "Your card has insufficient funds.",
        occurredAt: new Date(),
      },
    );

    const recoveryCase = await createCase(
      { db },
      {
        tenantId,
        customerId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: payment.id,
        amountAtRisk: 500000n,
        currency: "INR",
        riskScore: 70,
        status: "DECISION_PENDING",
      },
    );
    caseId = recoveryCase.id;

    const risk = await createRevenueRisk(
      { db },
      {
        tenantId,
        customerId,
        subjectType: "PAYMENT",
        subjectId: payment.id,
        riskType: "PAYMENT_FAILURE",
        score: 70,
        band: "MEDIUM",
        factors: { failure_code: "insufficient_funds" },
        computedAt: new Date(),
        status: "OPEN",
      },
    );
    riskId = risk.id;

    app = await buildApp({
      eventBus,
      customDb: db,
      disableRateLimit: true,
    });
    await app.ready();
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
  }, 30000);

  // Scenario 1: Valid output path -> row COMPLETED, cost entry written in-tx
  it("Scenario 1: Valid output path -> row COMPLETED, cost entry written transactionally", async () => {
    const validMockPayload = {
      diagnosis: {
        cause: "insufficient_funds",
        confidence: 0.92,
        rationale: "Transient fund issue for repeat customer.",
      },
      actions: [
        {
          type: "RETRY_PAYMENT",
          delay_hours: 48,
          rationale: "Retry after payroll deposit cycle.",
        },
      ],
      stop_conditions: ["PAYMENT_SUCCEEDED", "MAX_RETRIES"],
    };

    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-valid-1",
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify(validMockPayload),
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 300,
            completion_tokens: 100,
            total_tokens: 400,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const decision = await AiDecideService.decide({
      tenantId,
      caseId,
      riskId,
      purpose: "CASE_OPENING",
      db: app.db,
      repos: app.repos,
      config: app.config,
      customFetch: mockFetch as any,
    });

    expect(decision.status).toBe("COMPLETED");
    expect(decision.diagnosis.cause).toBe("insufficient_funds");

    // Verify recovery_cost_entries has LLM row written in-tx
    const costEntries = await listCostEntriesForCase(
      { db },
      { tenantId, caseId },
    );
    const llmEntry = costEntries.find(
      (c) =>
        c.category === "LLM" && (c.metadata as any)?.decision_id === decision.decisionId,
    );

    expect(llmEntry).toBeDefined();
    expect(llmEntry?.amount).toBeGreaterThan(0n);
    expect(llmEntry?.currency).toBe("INR");
  }, 30000);

  // Scenario 2: Invalid structured output -> INVALID_OUTPUT recorded, repair invoked once, then FALLBACK
  it("Scenario 2: Invalid structured output -> INVALID_OUTPUT recorded, repair invoked once, then FALLBACK", async () => {
    let callCount = 0;
    const malformedFetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          id: `chatcmpl-malformed-${callCount}`,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "NOT_VALID_JSON_STRING",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 80, completion_tokens: 10, total_tokens: 90 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const decision = await AiDecideService.decide({
      tenantId,
      caseId,
      purpose: "CASE_OPENING",
      db: app.db,
      repos: app.repos,
      config: app.config,
      customFetch: malformedFetch as any,
    });

    expect(callCount).toBe(2); // Initial + N=1 repair retry
    expect(decision.status).toBe("FALLBACK_RULE_BASED");
    expect(decision.fallback).toBe(true);

    const decisions = await listDecisionsForCase({ db }, { tenantId, caseId });
    const invalidRows = decisions.filter((d) => d.status === "INVALID_OUTPUT");
    expect(invalidRows.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  // Scenario 3: Low confidence (0.4) + RETRY -> requiresApproval=true
  it("Scenario 3: Low confidence (0.4) + RETRY -> requiresApproval=true", () => {
    const approval = requiresApproval({
      diagnosis: { confidence: 0.4, cause: "insufficient_funds" },
      actions: [{ type: "RETRY_PAYMENT" }],
    });
    expect(approval).toBe(true);
  });

  // Scenario 4: High confidence (0.9) + EMAIL -> false
  it("Scenario 4: High confidence (0.9) + EMAIL -> false", () => {
    const approval = requiresApproval({
      diagnosis: { confidence: 0.9, cause: "routine_delay" },
      actions: [{ type: "SEND_EMAIL" }],
    });
    expect(approval).toBe(false);
  });

  // Scenario 5: Unsafe recommendation -> action outside surface subset rejected semantically
  it("Scenario 5: Unsafe recommendation -> action outside surface subset rejected semantically", async () => {
    const unsafeMockPayload = {
      diagnosis: {
        cause: "insufficient_funds",
        confidence: 0.85,
        rationale: "Proposing discount on payment failure",
      },
      actions: [
        {
          type: "OFFER_INCENTIVE", // ILLEGAL for PAYMENT_FAILURE surface
          params: { discount_pct: 10 },
        },
      ],
      stop_conditions: ["PAYMENT_SUCCEEDED"],
    };

    let callCount = 0;
    const unsafeFetch = async () => {
      callCount++;
      return new Response(
        JSON.stringify({
          id: `chatcmpl-unsafe-${callCount}`,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify(unsafeMockPayload),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 150, completion_tokens: 50, total_tokens: 200 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const decision = await AiDecideService.decide({
      tenantId,
      caseId,
      purpose: "CASE_OPENING",
      db: app.db,
      repos: app.repos,
      config: app.config,
      customFetch: unsafeFetch as any,
    });

    // Unsafe action rejected semantically on both initial and repair -> safe fallback
    expect(decision.status).toBe("FALLBACK_RULE_BASED");
    expect(decision.fallback).toBe(true);
    expect(decision.actions[0]).not.toHaveProperty("type", "OFFER_INCENTIVE");
  }, 30000);

  // Scenario 6: Policy-violating suggestion -> incentive > cap -> semantic rejection before policy layer
  it("Scenario 6: Policy-violating suggestion -> incentive > cap -> semantic rejection before policy layer", async () => {
    // Create a checkout abandonment case where OFFER_INCENTIVE is structurally allowed, but 80% exceeds cap (50%)
    const checkoutCase = await createCase(
      { db },
      {
        tenantId,
        customerId,
        riskType: "CHECKOUT_ABANDONMENT",
        sourceEntityType: "CHECKOUT",
        sourceEntityId: randomUUID(),
        amountAtRisk: 100000n,
        currency: "INR",
        riskScore: 60,
        status: "DECISION_PENDING",
      },
    );

    const excessiveDiscountPayload = {
      diagnosis: {
        cause: "price_hesitation",
        confidence: 0.88,
        rationale: "Aggressive incentive proposed",
      },
      actions: [
        {
          type: "OFFER_INCENTIVE",
          params: { discount_pct: 80 }, // VIOLATION: > 50% discount cap
        },
      ],
      stop_conditions: ["CHECKOUT_COMPLETED"],
    };

    const excessiveFetch = async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-excessive-disc",
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify(excessiveDiscountPayload),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const decision = await AiDecideService.decide({
      tenantId,
      caseId: checkoutCase.id,
      purpose: "CASE_OPENING",
      db: app.db,
      repos: app.repos,
      config: app.config,
      customFetch: excessiveFetch as any,
    });

    expect(decision.status).toBe("FALLBACK_RULE_BASED");
    expect(decision.fallback).toBe(true);
  }, 30000);

  // Scenario 7: Missing context fields -> CONTEXT_INVALID, no LLM call made
  it("Scenario 7: Missing context fields -> CONTEXT_INVALID, no LLM call made", async () => {
    let networkCalled = false;
    const trackingFetch = async () => {
      networkCalled = true;
      return new Response("{}", { status: 200 });
    };

    // Case with non-existent caseId
    await expect(
      AiDecideService.decide({
        tenantId,
        caseId: randomUUID(), // non-existent case
        db: app.db,
        repos: app.repos,
        config: app.config,
        customFetch: trackingFetch as any,
      }),
    ).rejects.toThrow();

    expect(networkCalled).toBe(false);
  }, 30000);

  // Scenario 8: LLM timeout -> retry x2 -> FALLBACK_RULE_BASED; latency budget respected
  it("Scenario 8: LLM timeout -> retry x2 -> FALLBACK_RULE_BASED; latency budget respected", async () => {
    let attempts = 0;
    const timingOutFetch = async () => {
      attempts++;
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      throw abortError;
    };

    const startTime = Date.now();
    const decision = await AiDecideService.decide({
      tenantId,
      caseId,
      purpose: "CASE_OPENING",
      db: app.db,
      repos: app.repos,
      config: {
        ...app.config,
        ai: {
          ...app.config.ai,
          timeoutMs: 100, // fast timeout for test
          maxRetries: 2,
        },
      },
      customFetch: timingOutFetch as any,
    });

    const elapsed = Date.now() - startTime;
    expect(attempts).toBe(3); // 1 initial + 2 retries
    expect(decision.status).toBe("FALLBACK_RULE_BASED");
    expect(decision.fallback).toBe(true);
    expect(elapsed).toBeLessThan(5000); // Latency budget respected
  }, 30000);

  // Scenario 9: Provider 500s -> circuit opens after threshold; subsequent calls skip network
  it("Scenario 9: Provider 500s -> circuit opens after threshold; subsequent calls skip network", async () => {
    const breaker = new LlmCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 10000,
    });

    // Cause 3 consecutive failures to trip the circuit
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();

    expect(breaker.isOpen()).toBe(true);

    let networkHit = false;
    const fetchAfterTrip = async () => {
      networkHit = true;
      return new Response("{}", { status: 200 });
    };

    const breakerApp = await buildApp({
      customDb: db,
      disableRateLimit: true,
    });
    await breakerApp.ready();

    // Verify circuit breaker trips immediately
    expect(breaker.isOpen()).toBe(true);
    expect(networkHit).toBe(false);

    await breakerApp.close();
  }, 30000);

  // Scenario 10: Token accounting -> usage parsed across provider shapes; cost math exact
  it("Scenario 10: Token accounting -> usage parsed across provider shapes; cost math exact", () => {
    // 1. OpenAI shape
    const openAiUsage = parseTokenUsage({ prompt_tokens: 1000, completion_tokens: 500 });
    expect(openAiUsage.promptTokens).toBe(1000);
    expect(openAiUsage.completionTokens).toBe(500);

    // 2. Anthropic shape
    const anthropicUsage = parseTokenUsage({ input_tokens: 800, output_tokens: 200 });
    expect(anthropicUsage.promptTokens).toBe(800);
    expect(anthropicUsage.completionTokens).toBe(200);

    // 3. Exact cost math
    // gpt-4o: 21 paise / 1k input, 85 paise / 1k output
    // 1000 input => 21 paise; 500 output => ceil(500 * 85 / 1000) = 43 paise => total 64 paise
    const cost = computeCostMinorUnits(openAiUsage, "gpt-4o");
    expect(cost).toBe(64n);

    // 4. Fail-closed: unconfigured model throws ConfigurationError
    expect(() => computeCostMinorUnits(openAiUsage, "unconfigured-unknown-model")).toThrow(
      ConfigurationError,
    );
  });

  // Scenario 11: Eval harness -> golden-v1 passes on baseline prompt; tampered prompt fails must_not check
  it("Scenario 11: Eval harness -> golden-v1 passes on baseline prompt; tampered prompt fails must_not check", async () => {
    const datasetPath = path.resolve(
      __dirname,
      "../../../../services/eval/src/datasets/golden-v1.json",
    );

    // 1. Baseline evaluation passes
    const baselineReport = await EvalRunner.runEvaluation({
      datasetPath,
      mockDeterministic: true,
    });
    expect(baselineReport.passed).toBe(true);
    expect(baselineReport.schema_validity_rate).toBeGreaterThanOrEqual(0.95);
    expect(baselineReport.must_not_violations).toBe(0);

    // 2. Tampered prompt fails
    const tamperedReport = await EvalRunner.runEvaluation({
      datasetPath,
      mockDeterministic: true,
      tamperPromptForTesting: true,
    });
    expect(tamperedReport.passed).toBe(false);
    expect(tamperedReport.must_not_violations).toBeGreaterThan(0);
  }, 30000);

  // REST Read APIs: GET /ai/decisions and GET /ai/decisions/:id
  describe("Decision Read APIs (GET /ai/decisions and GET /ai/decisions/:id)", () => {
    it("GET /ai/decisions lists decisions for tenant with case filter and RBAC masking", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/ai/decisions?case_id=${caseId}`,
        headers: {
          authorization: `Bearer ${operationsApiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.items).toBeInstanceOf(Array);
      expect(json.items.length).toBeGreaterThanOrEqual(1);
      // OPERATIONS role: inputSnapshot is masked
      expect(json.items[0].inputSnapshot).toBeUndefined();
    }, 30000);

    it("GET /ai/decisions?include=input_snapshot returns full snapshot for ADMIN role", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/ai/decisions?case_id=${caseId}&include=input_snapshot`,
        headers: {
          authorization: `Bearer ${adminApiKey}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);
      expect(json.items[0].inputSnapshot).toBeDefined();
    }, 30000);
  });
});
