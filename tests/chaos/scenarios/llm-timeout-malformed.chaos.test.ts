/**
 * Chaos scenarios: LLM timeout + LLM malformed-response storm (Spec 01 §21).
 *
 * Acceptance: timeouts and malformed storms must never produce partial
 * decisions without rows, fallback bypassing policy, or cost rows without
 * decision rows. Every storm call lands a FALLBACK_RULE_BASED decision with a
 * matching LLM cost entry, and fallback metrics reflect the incident.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { db, listCostEntriesForCase, listDecisionsForCase } from "@repo/db";
import { AiDecideService } from "../../../apps/backend/src/modules/ai/decide.service";
import { resetChaosHarness } from "../harness/fault-points";
import { assertInvariants } from "../harness/assert-invariants";
import {
  buildChaosApp,
  counterValue,
  createChaosCase,
  createChaosCustomer,
  createChaosPayment,
  createChaosRisk,
  createChaosTenant,
} from "../harness/seed";

function malformedFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-chaos-malformed",
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "CHAOS_NOT_JSON {{{" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;
}

function hangingFetch(): typeof fetch {
  return (( _url: unknown, init?: { signal?: AbortSignal | null }) => {
    // Never resolves on its own: honors abort so the client timeout wins.
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    });
  }) as unknown as typeof fetch;
}

describe("chaos: LLM timeout + malformed storm", { timeout: 120000 }, () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildChaosApp());
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(() => {
    resetChaosHarness();
  });

  it("malformed ×3 concurrent → all FALLBACK with INVALID_OUTPUT rows + LLM costs", async () => {
    const tenant = await createChaosTenant("llmmalformed");
    const tenantId = tenant.id;
    const customer = await createChaosCustomer(tenantId);
    const payment = await createChaosPayment(tenantId, customer.id, "llm");
    const risk = await createChaosRisk(tenantId, customer.id, payment.id);
    const recoveryCase = await createChaosCase(tenantId, customer.id, payment, {
      status: "DECISION_PENDING",
      riskId: risk.id,
    });

    const fallbackBefore = await counterValue("fallback_total");

    const decisions = await Promise.all(
      [0, 1, 2].map(() =>
        AiDecideService.decide({
          tenantId,
          caseId: recoveryCase.id,
          riskId: risk.id,
          purpose: "CASE_OPENING",
          db: app.db,
          repos: app.repos,
          config: app.config,
          customFetch: malformedFetch(),
        }),
      ),
    );

    // Every storm call degrades to the deterministic rule-based fallback.
    for (const decision of decisions) {
      expect(decision.status).toBe("FALLBACK_RULE_BASED");
      expect(decision.fallback).toBe(true);
      expect(decision.actions.length).toBeGreaterThan(0);
    }

    // INVALID_OUTPUT rows are persisted (auditable), never silent partials.
    const rows = await listDecisionsForCase(
      { db },
      { tenantId, caseId: recoveryCase.id },
    );
    const invalidRows = rows.filter((d) => d.status === "INVALID_OUTPUT");
    const fallbackRows = rows.filter((d) => d.status === "FALLBACK_RULE_BASED");
    expect(invalidRows.length).toBeGreaterThanOrEqual(3);
    expect(fallbackRows.length).toBeGreaterThanOrEqual(3);

    // No cost row without a decision row: every decision carries LLM cost.
    const costs = await listCostEntriesForCase(
      { db },
      { tenantId, caseId: recoveryCase.id },
    );
    const llmCosts = costs.filter((c) => c.category === "LLM");
    expect(llmCosts.length).toBeGreaterThanOrEqual(rows.length);

    // Fallback metrics reflect the storm.
    const fallbackDelta = await counterValue("fallback_total") - fallbackBefore;
    expect(fallbackDelta).toBeGreaterThanOrEqual(1);

    await assertInvariants(tenantId);
  });

  it("hung model → client timeout wins → FALLBACK with LLM cost, no partial row", async () => {
    const tenant = await createChaosTenant("llmtimeout");
    const tenantId = tenant.id;
    const customer = await createChaosCustomer(tenantId);
    const payment = await createChaosPayment(tenantId, customer.id, "llmto");
    const risk = await createChaosRisk(tenantId, customer.id, payment.id);
    const recoveryCase = await createChaosCase(tenantId, customer.id, payment, {
      status: "DECISION_PENDING",
      riskId: risk.id,
    });

    const timeoutConfig = {
      ...app.config,
      ai: { ...app.config.ai, timeoutMs: 400, maxRetries: 1 },
    };

    const decision = await AiDecideService.decide({
      tenantId,
      caseId: recoveryCase.id,
      riskId: risk.id,
      purpose: "CASE_OPENING",
      db: app.db,
      repos: app.repos,
      config: timeoutConfig,
      customFetch: hangingFetch(),
    });

    expect(decision.status).toBe("FALLBACK_RULE_BASED");
    expect(decision.fallback).toBe(true);

    const rows = await listDecisionsForCase(
      { db },
      { tenantId, caseId: recoveryCase.id },
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((d) => d.status === "FALLBACK_RULE_BASED")).toBe(true);

    const costs = await listCostEntriesForCase(
      { db },
      { tenantId, caseId: recoveryCase.id },
    );
    expect(costs.filter((c) => c.category === "LLM").length).toBeGreaterThanOrEqual(1);

    await assertInvariants(tenantId);
  });
});
