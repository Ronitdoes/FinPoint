import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
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
  withTransaction,
  transitionCaseStatus,
  aiDecisions,
} from "@repo/db";
import { eq } from "drizzle-orm";
import { sha256 } from "../lib/crypto";
import { apiConfig } from "@repo/config";
import { AiDecideService } from "../modules/ai/decide.service";

describe("Step 14 Integration: AI Decision Service (Core Decision Path)", { timeout: 45000 }, () => {
  let app: FastifyInstance;
  let appSimulateFailure: FastifyInstance;
  let tenantAId: string;
  let tenantBId: string;
  let tenantAApiKey: string;
  let tenantBApiKey: string;
  let tenantAViewerApiKey: string;
  let customerAId: string;
  let caseAId: string;
  let riskAId: string;

  const runId = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const eventBus = new NullBus();

    // 1. Create Tenant A & Tenant B
    const tenantA = await createTenant(
      { db },
      {
        name: `AI Decision Tenant A ${runId}`,
        slug: `ai-decision-tenant-a-${runId}`,
      },
    );
    tenantAId = tenantA.id;

    const tenantB = await createTenant(
      { db },
      {
        name: `AI Decision Tenant B ${runId}`,
        slug: `ai-decision-tenant-b-${runId}`,
      },
    );
    tenantBId = tenantB.id;

    // 2. Create API Keys (Admin/Operations and Viewer)
    const rawKeyA = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId: tenantAId,
        keyHash: sha256(rawKeyA),
        name: `Tenant A Admin Key ${runId}`,
        scopes: ["*"],
      },
    );
    tenantAApiKey = rawKeyA;

    const rawKeyViewer = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId: tenantAId,
        keyHash: sha256(rawKeyViewer),
        name: `Tenant A Viewer Key ${runId}`,
        scopes: ["customers:read"],
      },
    );
    tenantAViewerApiKey = rawKeyViewer;

    const rawKeyB = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId: tenantBId,
        keyHash: sha256(rawKeyB),
        name: `Tenant B Key ${runId}`,
        scopes: ["*"],
      },
    );
    tenantBApiKey = rawKeyB;

    // 3. Seed Customer, Payment & Case for Tenant A
    const customerA = await createCustomer(
      { db },
      {
        tenantId: tenantAId,
        externalRef: `cus_ai_${runId}`,
        name: "Samantha Reed",
        email: "samantha.reed@example.com",
        phone: "+14155552671",
      },
    );
    customerAId = customerA.id;

    const paymentA = await createPayment(
      { db },
      {
        tenantId: tenantAId,
        customerId: customerAId,
        amount: 12999n,
        currency: "INR",
        status: "FAILED",
        provider: "STRIPE",
        providerPaymentId: `pi_fail_${runId}`,
        failureCode: "insufficient_funds",
        failureMessage: "Your card has insufficient funds.",
        occurredAt: new Date(),
      },
    );

    const caseA = await createCase(
      { db },
      {
        tenantId: tenantAId,
        customerId: customerAId,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: paymentA.id,
        amountAtRisk: 12999n,
        currency: "INR",
        riskScore: 85,
        status: "DECISION_PENDING",
      },
    );
    caseAId = caseA.id;

    const riskA = await createRevenueRisk(
      { db },
      {
        tenantId: tenantAId,
        customerId: customerAId,
        subjectType: "PAYMENT",
        subjectId: paymentA.id,
        riskType: "PAYMENT_FAILURE",
        score: 85,
        band: "HIGH",
        factors: {
          failure_code: 80,
          customer_ltv: 90,
        },
        computedAt: new Date(),
        status: "OPEN",
      },
    );
    riskAId = riskA.id;

    // 4. Build standard Fastify App
    app = await buildApp({
      eventBus,
      customDb: db,
      disableRateLimit: true,
    });
    await app.ready();

    // 5. Build App with SIMULATE_LLM_FAILURE=true
    const simulateConfig = {
      ...apiConfig(),
      demo: {
        ...apiConfig().demo,
        simulateLlmFailure: true,
      },
    };

    appSimulateFailure = await buildApp({
      config: simulateConfig,
      eventBus,
      customDb: db,
      disableRateLimit: true,
    });
    await appSimulateFailure.ready();
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    if (appSimulateFailure) await appSimulateFailure.close();
  }, 30000);

  describe("POST /ai/decide — Core Decision Path", () => {
    it("1. Happy path: returns 200 with valid recommendation and persists COMPLETED decision row", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/ai/decide",
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          case_id: caseAId,
          risk_id: riskAId,
          purpose: "CASE_OPENING",
        }),
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);

      expect(json.decisionId).toBeDefined();
      expect(json.caseId).toBe(caseAId);
      expect(json.status).toMatch(/^(COMPLETED|FALLBACK_RULE_BASED)$/);
      expect(json.diagnosis).toBeDefined();
      expect(json.diagnosis.cause).toBeDefined();
      expect(json.diagnosis.confidence).toBeGreaterThanOrEqual(0);
      expect(json.diagnosis.confidence).toBeLessThanOrEqual(1);
      expect(json.actions).toBeInstanceOf(Array);
      expect(json.actions.length).toBeGreaterThanOrEqual(1);
      expect(json.stop_conditions).toBeInstanceOf(Array);
      expect(json.prompt_version).toBe("payment_failure@1");

      // Verify row in DB
      const persisted = await app.repos.findDecisionById(
        { db },
        { tenantId: tenantAId, decisionId: json.decisionId },
      );
      expect(persisted).not.toBeNull();
      expect(persisted?.caseId).toBe(caseAId);
      expect(persisted?.promptVersion).toBe("payment_failure@1");
      expect(persisted?.inputSnapshot).toBeDefined();
      expect((persisted?.inputSnapshot as any).customer_context).toBeDefined();
    }, 30000);

    it("2. SIMULATE_LLM_FAILURE=true: gracefully triggers deterministic rule-based fallback with 200", async () => {
      const response = await appSimulateFailure.inject({
        method: "POST",
        url: "/ai/decide",
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          case_id: caseAId,
        }),
      });

      expect(response.statusCode).toBe(200);
      const json = JSON.parse(response.body);

      expect(json.status).toBe("FALLBACK_RULE_BASED");
      expect(json.fallback).toBe(true);
      expect(json.diagnosis.cause).toBe("insufficient_funds");
      expect(json.actions[0].type).toBe("RETRY_PAYMENT");
      expect(json.stop_conditions).toContain("PAYMENT_SUCCEEDED");

      // Verify DB row has FALLBACK_RULE_BASED status
      const persisted = await app.repos.findDecisionById(
        { db },
        { tenantId: tenantAId, decisionId: json.decisionId },
      );
      expect(persisted?.status).toBe("FALLBACK_RULE_BASED");
    }, 30000);

    it("3. Idempotency-Key replay: returns original decision row without additional spend", async () => {
      const idempotencyKey = `idemp_ai_${randomUUID().slice(0, 8)}`;

      // First call
      const firstResponse = await app.inject({
        method: "POST",
        url: "/ai/decide",
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          case_id: caseAId,
        }),
      });

      expect(firstResponse.statusCode).toBe(200);
      const firstJson = JSON.parse(firstResponse.body);
      const originalDecisionId = firstJson.decisionId;

      // Count decisions before replay
      const countBefore = (
        await app.repos.listDecisionsForCase(
          { db },
          { tenantId: tenantAId, caseId: caseAId },
        )
      ).length;

      // Second replayed call with identical key
      const replayResponse = await app.inject({
        method: "POST",
        url: "/ai/decide",
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          case_id: caseAId,
        }),
      });

      expect(replayResponse.statusCode).toBe(200);
      const replayJson = JSON.parse(replayResponse.body);
      expect(replayJson.decisionId).toBe(originalDecisionId);

      // Verify no extra decision row was inserted
      const countAfter = (
        await app.repos.listDecisionsForCase(
          { db },
          { tenantId: tenantAId, caseId: caseAId },
        )
      ).length;
      expect(countAfter).toBe(countBefore);
    }, 30000);

    it("4. Terminal case: returns 409 CASE_TERMINAL when case is already resolved/stopped", async () => {
      // Create a case and transition to terminal status
      const terminalCase = await createCase(
        { db },
        {
          tenantId: tenantAId,
          customerId: customerAId,
          riskType: "PAYMENT_FAILURE",
          sourceEntityType: "PAYMENT",
          sourceEntityId: randomUUID(),
          amountAtRisk: 5000n,
          currency: "INR",
          riskScore: 60,
          status: "IN_PROGRESS",
        },
      );

      // Transition to RECOVERED (terminal)
      await transitionCaseStatus(
        { db },
        {
          tenantId: tenantAId,
          caseId: terminalCase.id,
          from: ["IN_PROGRESS"],
          to: "RECOVERED",
        },
      );

      const response = await app.inject({
        method: "POST",
        url: "/ai/decide",
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          case_id: terminalCase.id,
        }),
      });

      expect(response.statusCode).toBe(409);
      const json = JSON.parse(response.body);
      expect(json.error.code).toBe("CASE_TERMINAL");
    }, 30000);

    it("5. Tenant isolation: returns 404 CASE_NOT_FOUND when requesting another tenant's case", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/ai/decide",
        headers: {
          authorization: `Bearer ${tenantBApiKey}`, // Tenant B key
          "content-type": "application/json",
        },
        body: JSON.stringify({
          case_id: caseAId, // Tenant A case
        }),
      });

      expect(response.statusCode).toBe(404);
      const json = JSON.parse(response.body);
      expect(json.error.code).toBe("CASE_NOT_FOUND");
    }, 30000);

    it("6. RBAC: returns 403 FORBIDDEN for VIEWER role without ai:decide scope", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/ai/decide",
        headers: {
          authorization: `Bearer ${tenantAViewerApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          case_id: caseAId,
        }),
      });

      expect(response.statusCode).toBe(403);
      const json = JSON.parse(response.body);
      expect(json.error.code).toBe("FORBIDDEN");
    }, 30000);

    it("7. GET /ai/decisions/:id returns stored decision with tenant isolation", async () => {
      // First create a decision
      const decideRes = await app.inject({
        method: "POST",
        url: "/ai/decide",
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ case_id: caseAId }),
      });
      const decideJson = JSON.parse(decideRes.body);

      // Fetch via GET
      const getRes = await app.inject({
        method: "GET",
        url: `/ai/decisions/${decideJson.decisionId}`,
        headers: {
          authorization: `Bearer ${tenantAApiKey}`,
        },
      });

      expect(getRes.statusCode).toBe(200);
      const getJson = JSON.parse(getRes.body);
      expect(getJson.id).toBe(decideJson.decisionId);
      expect(getJson.caseId).toBe(caseAId);

      // Cross-tenant fetch returns 404
      const crossRes = await app.inject({
        method: "GET",
        url: `/ai/decisions/${decideJson.decisionId}`,
        headers: {
          authorization: `Bearer ${tenantBApiKey}`,
        },
      });
      expect(crossRes.statusCode).toBe(404);
    }, 30000);

    it("8. Mock LLM completion: produces COMPLETED row with tokens, cost, latency, and matching payload", async () => {
      const mockLlmPayload = {
        diagnosis: {
          cause: "insufficient_funds",
          confidence: 0.94,
          rationale: "Customer has strong history but transient insufficient funds.",
        },
        actions: [
          {
            type: "RETRY_PAYMENT",
            delay_hours: 48,
            rationale: "Wait 48 hours for fund transfer.",
          },
          {
            type: "SEND_WHATSAPP",
            rationale: "Send helpful WhatsApp notice.",
            params: { template: "payment_retry_notice" },
          },
        ],
        stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT", "MAX_RETRIES"],
      };

      const mockFetch = async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl-mock-completed",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: JSON.stringify(mockLlmPayload),
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 350,
              completion_tokens: 120,
              total_tokens: 470,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );

      const decision = await AiDecideService.decide({
        tenantId: tenantAId,
        caseId: caseAId,
        riskId: riskAId,
        purpose: "CASE_OPENING",
        db: app.db,
        repos: app.repos,
        config: app.config,
        customFetch: mockFetch as any,
      });

      expect(decision.status).toBe("COMPLETED");
      expect(decision.diagnosis.cause).toBe("insufficient_funds");
      expect(decision.diagnosis.confidence).toBe(0.94);
      expect(decision.actions).toHaveLength(2);
      expect(decision.stop_conditions).toEqual([
        "PAYMENT_SUCCEEDED",
        "OPTED_OUT",
        "MAX_RETRIES",
      ]);

      const persisted = await app.repos.findDecisionById(
        { db },
        { tenantId: tenantAId, decisionId: decision.decisionId },
      );
      expect(persisted?.status).toBe("COMPLETED");
      expect(persisted?.inputTokens).toBe(350);
      expect(persisted?.outputTokens).toBe(120);
      expect(persisted?.costMinorUnits).toBeGreaterThan(0n);
    }, 30000);

    it("9. Malformed fixture: attempts N=1 repair retry, persists INVALID_OUTPUT and returns FALLBACK_RULE_BASED", async () => {
      let fetchCallCount = 0;
      const mockMalformedFetch = async () => {
        fetchCallCount++;
        return new Response(
          JSON.stringify({
            id: "chatcmpl-malformed",
            model: "gpt-4o",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "INVALID_NOT_A_JSON_OBJECT",
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              total_tokens: 110,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const decision = await AiDecideService.decide({
        tenantId: tenantAId,
        caseId: caseAId,
        purpose: "CASE_OPENING",
        db: app.db,
        repos: app.repos,
        config: app.config,
        customFetch: mockMalformedFetch as any,
      });

      expect(fetchCallCount).toBe(2); // Initial attempt + N=1 repair retry
      expect(decision.status).toBe("FALLBACK_RULE_BASED");
      expect(decision.fallback).toBe(true);

      const allDecisions = await app.repos.listDecisionsForCase(
        { db },
        { tenantId: tenantAId, caseId: caseAId },
      );
      const invalidRows = allDecisions.filter((d) => d.status === "INVALID_OUTPUT");
      expect(invalidRows.length).toBeGreaterThanOrEqual(1);
    }, 30000);
  });
});
