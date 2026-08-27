import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { NullBus } from "@repo/integrations";
import {
  db,
  createTenant,
  createApiKey,
  createUser,
  createCustomer,
  createCase,
  createPayment,
  insertMessage,
  createDecision,
  findPolicyRuleByCode,
  listPolicyRules,
  listPolicyVersions,
  listPolicyEvaluationsForCase,
  type Tenant,
} from "@repo/db";
import { sha256 } from "../lib/crypto";
import { PolicyEvaluationFailedError } from "../lib/errors";
import { PolicyService } from "../modules/policy/policy.service";
import { DEFAULT_POLICY_RULES } from "@repo/policy";

describe("Step 16 Integration: Policy Engine & Endpoints", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let policyService: PolicyService;

  let tenantA: Tenant;
  let tenantB: Tenant;

  let workerApiKeyA: string;
  let workerNoScopeApiKeyA: string;
  let tenantBApiKey: string;

  let operationsUserId: string;
  let viewerUserId: string;

  let normalCaseId: string;
  let optOutCaseId: string;
  let retryCappedCaseId: string;
  let highValueCaseId: string;
  let succeededCaseId: string;
  let testDecisionId: string;

  const runId = randomUUID().slice(0, 8);

  beforeAll(async () => {
    const eventBus = new NullBus();

    // 1. Create Tenant A and Tenant B
    tenantA = await createTenant(
      { db },
      {
        name: `Policy Tenant A ${runId}`,
        slug: `policy-tenant-a-${runId}`,
      },
    );

    tenantB = await createTenant(
      { db },
      {
        name: `Policy Tenant B ${runId}`,
        slug: `policy-tenant-b-${runId}`,
      },
    );

    // 2. Create API Keys for Tenant A
    const rawWorkerKey = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId: tenantA.id,
        keyHash: sha256(rawWorkerKey),
        name: `Worker Policy Key ${runId}`,
        scopes: ["policy:evaluate"],
      },
    );
    workerApiKeyA = rawWorkerKey;

    const rawNoScopeKey = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId: tenantA.id,
        keyHash: sha256(rawNoScopeKey),
        name: `Worker No Scope Key ${runId}`,
        scopes: ["events:write"], // missing policy:evaluate
      },
    );
    workerNoScopeApiKeyA = rawNoScopeKey;

    const rawKeyB = `rrk_${randomUUID().replace(/-/g, "")}`;
    await createApiKey(
      { db },
      {
        tenantId: tenantB.id,
        keyHash: sha256(rawKeyB),
        name: `Tenant B Key ${runId}`,
        scopes: ["*"],
      },
    );
    tenantBApiKey = rawKeyB;

    // 3. Create Users for Tenant A with RBAC roles
    const opUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `ops_${runId}@example.com`,
        name: "Ops Specialist",
        passwordHash: "dummy_hash",
        role: "OPERATIONS",
        status: "ACTIVE",
      },
    );
    operationsUserId = opUser.id;

    const viewUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `viewer_${runId}@example.com`,
        name: "Read-only Viewer",
        passwordHash: "dummy_hash",
        role: "VIEWER",
        status: "ACTIVE",
      },
    );
    viewerUserId = viewUser.id;

    // Build fastify test app instance
    app = await buildApp({ eventBus, disableRateLimit: true });
    await app.ready();

    // 4. Seed Default 9 Policy Rules
    policyService = new PolicyService(db, app.repos);
    await policyService.seedDefaultPolicies();

    // 5. Seed Test Customers & Cases
    // Normal Customer & Case
    const normalCustomer = await createCustomer(
      { db },
      {
        tenantId: tenantA.id,
        externalRef: `cus_normal_${runId}`,
        name: "Normal Customer",
        email: `normal_${runId}@example.com`,
        optedOut: false,
      },
    );

    const normalCase = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: normalCustomer.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: randomUUID(),
        amountAtRisk: 50_000n, // ₹500
        currency: "INR",
        riskScore: 45,
        status: "IN_PROGRESS",
      },
    );
    normalCaseId = normalCase.id;

    // Seed AI Decision for normal case
    const dec = await createDecision(
      { db },
      {
        tenantId: tenantA.id,
        caseId: normalCase.id,
        model: "gpt-4o",
        promptVersion: "payment_failure@1",
        inputSnapshot: { caseId: normalCase.id },
        diagnosisCause: "INSUFFICIENT_FUNDS",
        diagnosisConfidence: "0.85",
        recommendedActions: [{ type: "RETRY_PAYMENT", params: { attempt_number: 1 } }],
        status: "COMPLETED",
      },
    );
    testDecisionId = dec.id;

    // Opted-out Customer & Case
    const optOutCustomer = await createCustomer(
      { db },
      {
        tenantId: tenantA.id,
        externalRef: `cus_optout_${runId}`,
        name: "Opt-out Customer",
        email: `optout_${runId}@example.com`,
        optedOut: true,
      },
    );

    const optOutCase = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: optOutCustomer.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: randomUUID(),
        amountAtRisk: 40_000n,
        currency: "INR",
        riskScore: 50,
        status: "IN_PROGRESS",
      },
    );
    optOutCaseId = optOutCase.id;

    // Retry-capped Customer & Case (already sent 3 retries or retry count = 3)
    const retryCappedCase = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: normalCustomer.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: randomUUID(),
        amountAtRisk: 60_000n,
        currency: "INR",
        riskScore: 70,
        status: "IN_PROGRESS",
      },
    );
    retryCappedCaseId = retryCappedCase.id;

    // High Value Case (> ₹100,000 = 10,000,000 paise)
    const highValueCase = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: normalCustomer.id,
        riskType: "INVOICE_OVERDUE",
        sourceEntityType: "INVOICE",
        sourceEntityId: randomUUID(),
        amountAtRisk: 15_000_000n, // ₹150,000
        currency: "INR",
        riskScore: 65,
        status: "IN_PROGRESS",
      },
    );
    highValueCaseId = highValueCase.id;

    // Succeeded Case
    const succeededCase = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: normalCustomer.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "PAYMENT",
        sourceEntityId: randomUUID(),
        amountAtRisk: 25_000n,
        currency: "INR",
        riskScore: 10,
        status: "RECOVERED", // resolved/succeeded
      },
    );
    succeededCaseId = succeededCase.id;
  }, 60000);

  afterAll(async () => {
    if (app) await app.close();
  }, 60000);

  describe("1. Seed Verification (9 Default Rules)", () => {
    it("seeds all 9 platform default rules with tenant_id = NULL and version 1", async () => {
      const allRules = await listPolicyRules({ db }, { tenantId: undefined });
      const defaultRules = allRules.filter((r) => r.tenantId === null);

      expect(defaultRules.length).toBeGreaterThanOrEqual(9);

      const codes = defaultRules.map((r) => r.code);
      expect(codes).toContain("POL-OPTOUT");
      expect(codes).toContain("POL-DISPUTE");
      expect(codes).toContain("POL-MAXRETRY");
      expect(codes).toContain("POL-WA-CAP");
      expect(codes).toContain("POL-EM-CAP");
      expect(codes).toContain("POL-DISCOUNT");
      expect(codes).toContain("POL-HIGHVALUE");
      expect(codes).toContain("POL-CONFIDENCE");
      expect(codes).toContain("POL-PAYMENT-SUCCESS");

      // Verify each default rule has an active version 1 snapshot
      for (const rule of defaultRules) {
        const versions = await listPolicyVersions({ db }, { ruleId: rule.id });
        expect(versions.length).toBeGreaterThanOrEqual(1);
        expect(versions[0]?.version).toBe(1);
        expect(versions[0]?.snapshot).toBeDefined();
      }
    }, 30000);

    it("seeding is idempotent (multiple runs do not duplicate rules)", async () => {
      const result = await policyService.seedDefaultPolicies();
      expect(result.created).toBe(0);
      expect(result.existing).toBeGreaterThanOrEqual(9);
    }, 30000);
  });

  describe("2. POST /policy/evaluate — Authorization & Authentication", () => {
    it("allows worker API key with 'policy:evaluate' scope", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/policy/evaluate",
        headers: {
          authorization: `Bearer ${workerApiKeyA}`,
          "content-type": "application/json",
        },
        payload: {
          case_id: normalCaseId,
          actions: [{ type: "SEND_EMAIL", params: { template: "reminder_v1" } }],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.allowed).toBe(true);
      expect(body.result).toBe("ALLOWED");
      expect(body.evaluationId).toBeDefined();
      expect(body.latency_ms).toBeGreaterThanOrEqual(1);
      expect(body.effective_actions).toHaveLength(1);
      expect(body.effective_actions[0].status).toBe("ALLOWED");
    }, 30000);

    it("rejects unauthenticated request with 401 UNAUTHENTICATED", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/policy/evaluate",
        headers: { "content-type": "application/json" },
        payload: {
          case_id: normalCaseId,
          actions: [{ type: "SEND_EMAIL", params: {} }],
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("UNAUTHENTICATED");
    }, 30000);

    it("rejects worker API key missing 'policy:evaluate' scope with 403 FORBIDDEN", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/policy/evaluate",
        headers: {
          authorization: `Bearer ${workerNoScopeApiKeyA}`,
          "content-type": "application/json",
        },
        payload: {
          case_id: normalCaseId,
          actions: [{ type: "SEND_EMAIL", params: {} }],
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    }, 30000);

    it("returns 404 CASE_NOT_FOUND when case does not exist", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/policy/evaluate",
        headers: {
          authorization: `Bearer ${workerApiKeyA}`,
          "content-type": "application/json",
        },
        payload: {
          case_id: randomUUID(),
          actions: [{ type: "SEND_EMAIL", params: {} }],
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("CASE_NOT_FOUND");
    }, 30000);

    it("enforces tenant isolation (Tenant B cannot evaluate Tenant A case)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/policy/evaluate",
        headers: {
          authorization: `Bearer ${tenantBApiKey}`,
          "content-type": "application/json",
        },
        payload: {
          case_id: normalCaseId,
          actions: [{ type: "SEND_EMAIL", params: {} }],
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("CASE_NOT_FOUND");
    }, 30000);
  });

  describe("3. End-to-End Evaluation Scenarios & Hard Rules", () => {
    it("POL-OPTOUT: rejects outbound contact actions for opted-out customer", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/policy/evaluate",
        headers: {
          authorization: `Bearer ${workerApiKeyA}`,
          "content-type": "application/json",
        },
        payload: {
          case_id: optOutCaseId,
          actions: [
            { type: "SEND_EMAIL", params: { template: "payment_failed" } },
            { type: "SEND_WHATSAPP", params: { template: "payment_failed_wa" } },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.allowed).toBe(false);
      expect(body.result).toBe("REJECTED");
      expect(body.rejections).toHaveLength(2);
      expect(body.rejections[0].rule_code).toBe("POL-OPTOUT");
      expect(body.rejections[0].reason).toBe("CUSTOMER_OPTED_OUT");
      expect(body.effective_actions).toHaveLength(0);
    }, 30000);

    it("POL-HIGHVALUE: triggers REQUIRE_APPROVAL for invoice > ₹100,000", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/policy/evaluate",
        headers: {
          authorization: `Bearer ${workerApiKeyA}`,
          "content-type": "application/json",
        },
        payload: {
          case_id: highValueCaseId,
          actions: [
            {
              type: "CREATE_PAYMENT_LINK",
              params: { amount_minor: 15_000_000, currency: "INR", expires_in_hours: 48 },
            },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.allowed).toBe(false);
      expect(body.required_approval).toBe(true);
      expect(body.result).toBe("REQUIRE_APPROVAL");
      expect(body.effective_actions).toHaveLength(1);
      expect(body.effective_actions[0].status).toBe("REQUIRE_APPROVAL");
    }, 30000);

    it("POL-PAYMENT-SUCCESS: halts all actions when case is already RECOVERED", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/policy/evaluate",
        headers: {
          authorization: `Bearer ${workerApiKeyA}`,
          "content-type": "application/json",
        },
        payload: {
          case_id: succeededCaseId,
          actions: [
            { type: "RETRY_PAYMENT", params: { attempt_number: 1 } },
            { type: "SEND_EMAIL", params: {} },
          ],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.allowed).toBe(false);
      expect(body.result).toBe("REJECTED");
      expect(body.rejections[0].rule_code).toBe("POL-PAYMENT-SUCCESS");
      expect(body.rejections[0].reason).toBe("PAYMENT_ALREADY_SUCCEEDED");
    }, 30000);

    it("persists evaluation audit rows in policy_evaluations table", async () => {
      const evaluations = await listPolicyEvaluationsForCase(
        { db },
        { tenantId: tenantA.id, caseId: normalCaseId },
      );

      expect(evaluations.length).toBeGreaterThanOrEqual(1);
      const latest = evaluations[0];
      expect(latest?.result).toBe("ALLOWED");
      expect(latest?.ruleVersions.length).toBeGreaterThan(0);
      expect(latest?.latencyMs).toBeGreaterThanOrEqual(1);
    }, 30000);
  });

  describe("4. Policy CRUD & Snapshot Versioning Lifecycle", () => {
    let customRuleId: string;

    it("GET /policies: lists platform defaults + tenant rules", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/policies",
        headers: {
          authorization: `Bearer ${workerApiKeyA}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const { policies } = res.json();
      expect(policies.length).toBeGreaterThanOrEqual(9);
      expect(policies.some((p: any) => p.code === "POL-MAXRETRY")).toBe(true);
      expect(policies[0].activeVersion).toBe(1);
    }, 30000);

    it("POST /policies: creates tenant custom rule and initial snapshot version 1", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/policies",
        headers: {
          authorization: `Bearer ${workerApiKeyA}`,
          "content-type": "application/json",
        },
        payload: {
          code: `CUSTOM-RISK-CAP-${runId}`,
          name: "Custom Risk Cap Rule",
          description: "Reject payment retries if risk score > 80",
          ruleKind: "REJECT",
          definition: {
            applies_to: ["RETRY_PAYMENT"],
            conditions: [{ field: "case.risk_score", op: "gt", value: 80 }],
            effect: "REJECT",
            reason_code: "HIGH_RISK_RETRY_BLOCKED",
          },
          enabled: true,
        },
      });

      expect(res.statusCode).toBe(201);
      const created = res.json();
      customRuleId = created.id;
      expect(created.code).toBe(`CUSTOM-RISK-CAP-${runId}`);
      expect(created.activeVersion).toBe(1);
      expect(created.tenantId).toBe(tenantA.id);

      // Verify version 1 row in database
      const versions = await listPolicyVersions({ db }, { ruleId: customRuleId });
      expect(versions).toHaveLength(1);
      expect(versions[0]?.version).toBe(1);
    }, 30000);

    it("PATCH /policies/:id: bumps version to 2 with new immutable snapshot", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/policies/${customRuleId}`,
        headers: {
          authorization: `Bearer ${workerApiKeyA}`,
          "content-type": "application/json",
        },
        payload: {
          name: "Updated Custom Risk Cap Rule v2",
          definition: {
            applies_to: ["RETRY_PAYMENT"],
            conditions: [{ field: "case.risk_score", op: "gt", value: 75 }], // lowered threshold to 75
            effect: "REJECT",
            reason_code: "HIGH_RISK_RETRY_BLOCKED_V2",
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const updated = res.json();
      expect(updated.name).toBe("Updated Custom Risk Cap Rule v2");
      expect(updated.activeVersion).toBe(2);

      // Verify version history has 2 versions
      const versions = await listPolicyVersions({ db }, { ruleId: customRuleId });
      expect(versions).toHaveLength(2);
      expect(versions[0]?.version).toBe(2);
      expect(versions[1]?.version).toBe(1);
    }, 30000);

    it("GET /policies/:id/versions: returns ordered version history", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/policies/${customRuleId}/versions`,
        headers: {
          authorization: `Bearer ${workerApiKeyA}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const { versions } = res.json();
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(2);
      expect(versions[1].version).toBe(1);
    }, 30000);
  });

  describe("5. Fail-Closed Resilience Guarantee", () => {
    it("guarantees fail-closed error with POLICY_EVALUATION_FAILED when repository throws", async () => {
      const faultyService = new PolicyService(db, {
        ...app.repos,
        findCaseById: async () => {
          throw new Error("Simulated Database Outage during evaluation");
        },
      } as any);

      await expect(
        faultyService.evaluatePolicy(tenantA.id, {
          case_id: normalCaseId,
          actions: [{ type: "RETRY_PAYMENT", params: {} }],
        }),
      ).rejects.toThrow(PolicyEvaluationFailedError);

      try {
        await faultyService.evaluatePolicy(tenantA.id, {
          case_id: normalCaseId,
          actions: [{ type: "RETRY_PAYMENT", params: {} }],
        });
      } catch (err: any) {
        expect(err).toBeInstanceOf(PolicyEvaluationFailedError);
        expect(err.code).toBe("POLICY_EVALUATION_FAILED");
        expect(err.statusCode).toBe(500);
      }
    }, 30000);
  });
});
