import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import {
  PaymentExecutionService,
  PaymentRefreshService,
} from "../modules/payments";
import {
  MockPaymentProvider,
  NullBus,
  type RetryPaymentInput,
  type PaymentProvider,
} from "@repo/integrations";
import {
  createTenant,
  createCustomer,
  createPayment,
  createCase,
  insertAction,
  findPaymentById,
  findPaymentAttemptsByPaymentId,
  listCostEntriesForCase,
  createApiKey,
  createUser,
  createSession,
  type Payment,
  type RecoveryCase,
  type Customer,
  type Tenant,
} from "@repo/db";

function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("Payment Provider Adapters & Execution Service Integration", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let eventBus: NullBus;
  let tenant: Tenant;
  let customer: Customer;
  let testPayment: Payment;
  let testCase: RecoveryCase;
  let adminApiKey: string;
  let viewerCookie: string;
  let adminCookie: string;

  const createTestUserSession = async (
    tenantId: string,
    role: "VIEWER" | "SUPPORT" | "OPERATIONS" | "FINANCE" | "ADMIN",
  ): Promise<string> => {
    const runId = randomUUID().slice(0, 8);
    const user = await createUser(
      { db: app.db },
      {
        tenantId,
        email: `${role.toLowerCase()}_${runId}@example.com`,
        name: `${role} User`,
        passwordHash: "dummy_hash",
        role,
        status: "ACTIVE",
      },
    );

    const rawToken = randomUUID();
    await createSession(
      { db: app.db },
      {
        userId: user.id,
        tokenHash: sha256(rawToken),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    );

    return rawToken;
  };

  beforeAll(async () => {
    eventBus = new NullBus();
    app = await buildApp({
      eventBus,
      disableRateLimit: true,
    });

    await app.ready();

    const runId = randomUUID().substring(0, 8);

    // Seed test tenant & customer
    tenant = await createTenant(
      { db: app.db },
      {
        name: `Payments Test Tenant ${runId}`,
        slug: `payments-test-${runId}`,
      },
    );
    customer = await createCustomer(
      { db: app.db },
      {
        tenantId: tenant.id,
        email: `customer-${runId}@example.com`,
        name: "Test Customer",
        phone: "+15550009999",
      },
    );

    // Seed API key for machine calls
    const rawAdminKey = `rrk_${tenant.id.replace(/-/g, "").substring(0, 8)}_admin1234567890`;
    await createApiKey(
      { db: app.db },
      {
        tenantId: tenant.id,
        keyHash: sha256(rawAdminKey),
        name: "Admin Key",
      },
    );
    adminApiKey = rawAdminKey;

    // Seed user sessions for role-based testing
    viewerCookie = await createTestUserSession(tenant.id, "VIEWER");
    adminCookie = await createTestUserSession(tenant.id, "ADMIN");
  }, 60000);

  beforeEach(async () => {
    MockPaymentProvider.clearOverrides();

    // Fresh payment & recovery case per test
    testPayment = await createPayment(
      { db: app.db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        amount: 15000n, // $150.00
        currency: "USD",
        status: "FAILED",
        provider: "MOCK",
        providerPaymentId: `pi_mock_${randomUUID().substring(0, 8)}`,
        occurredAt: new Date(),
      },
    );

    testCase = await createCase(
      { db: app.db },
      {
        tenantId: tenant.id,
        customerId: customer.id,
        sourceEntityType: "PAYMENT",
        sourceEntityId: testPayment.id,
        riskType: "PAYMENT_FAILURE",
        riskScore: 85,
        amountAtRisk: 15000n,
        currency: "USD",
        status: "IN_PROGRESS",
      },
    );
  }, 30000);

  afterAll(async () => {
    await app.close();
  });

  describe("1. Idempotency & Double-Charge Prevention", () => {
    it("short-circuits on duplicate idempotency key and prevents double charging", async () => {
      const mockAdapter = new MockPaymentProvider({ defaultSuccessOnAttempt: 1 });
      const retrySpy = vi.spyOn(mockAdapter, "retryPayment");

      const executionService = new PaymentExecutionService(
        app.db,
        app.repos,
        app.config,
        mockAdapter,
      );

      // First call -> executes retry successfully
      const firstResult = await executionService.executeRetryPayment({
        tenantId: tenant.id,
        caseId: testCase.id,
        paymentId: testPayment.id,
        attemptNumber: 1,
      });

      expect(firstResult.outcome).toBe("SUCCEEDED");
      expect(firstResult.duplicate).toBeFalsy();
      expect(retrySpy).toHaveBeenCalledTimes(1);

      // Second call with EXACT SAME attemptNumber / idempotency key
      const secondResult = await executionService.executeRetryPayment({
        tenantId: tenant.id,
        caseId: testCase.id,
        paymentId: testPayment.id,
        attemptNumber: 1,
      });

      expect(secondResult.outcome).toBe("SUCCEEDED");
      expect(secondResult.duplicate).toBe(true);
      // Adapter must NOT be hit a second time!
      expect(retrySpy).toHaveBeenCalledTimes(1);

      // Verify DB has exactly one attempt row
      const attempts = await findPaymentAttemptsByPaymentId(
        { db: app.db },
        { tenantId: tenant.id, paymentId: testPayment.id },
      );
      expect(attempts).toHaveLength(1);
      expect(attempts[0].status).toBe("SUCCEEDED");
    });

    it("handles concurrent executions safely without duplicate charges", async () => {
      const mockAdapter = new MockPaymentProvider({ defaultSuccessOnAttempt: 1 });
      const retrySpy = vi.spyOn(mockAdapter, "retryPayment");

      const executionService = new PaymentExecutionService(
        app.db,
        app.repos,
        app.config,
        mockAdapter,
      );

      // Execute 3 simultaneous promises with identical keys
      const [res1, res2, res3] = await Promise.all([
        executionService.executeRetryPayment({
          tenantId: tenant.id,
          caseId: testCase.id,
          paymentId: testPayment.id,
          attemptNumber: 1,
        }),
        executionService.executeRetryPayment({
          tenantId: tenant.id,
          caseId: testCase.id,
          paymentId: testPayment.id,
          attemptNumber: 1,
        }),
        executionService.executeRetryPayment({
          tenantId: tenant.id,
          caseId: testCase.id,
          paymentId: testPayment.id,
          attemptNumber: 1,
        }),
      ]);

      expect(res1.outcome).toBe("SUCCEEDED");
      expect(res2.outcome).toBe("SUCCEEDED");
      expect(res3.outcome).toBe("SUCCEEDED");

      // Provider was called at most once for this attempt
      expect(retrySpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("2. Payment Retry Execution Lifecycle", () => {
    it("completes success lifecycle, claims action, updates payments, and captures fee", async () => {
      const mockAdapter = new MockPaymentProvider({ defaultSuccessOnAttempt: 1 });
      const executionService = new PaymentExecutionService(
        app.db,
        app.repos,
        app.config,
        mockAdapter,
      );

      const action = await insertAction(
        { db: app.db },
        {
          tenantId: tenant.id,
          caseId: testCase.id,
          type: "RETRY_PAYMENT",
          parameters: { amount: 15000 },
          status: "PROPOSED",
          idempotencyKey: `${tenant.id}:${testCase.id}:RETRY_PAYMENT:1`,
        },
      );

      const result = await executionService.executeRetryPayment({
        tenantId: tenant.id,
        caseId: testCase.id,
        paymentId: testPayment.id,
        attemptNumber: 1,
        actionId: action.id,
      });

      expect(result.outcome).toBe("SUCCEEDED");
      expect(result.fee).toBeDefined();

      // Check payment record updated to SUCCEEDED
      const updatedPayment = await findPaymentById(
        { db: app.db },
        { tenantId: tenant.id, paymentId: testPayment.id },
      );
      expect(updatedPayment?.status).toBe("SUCCEEDED");
      expect(updatedPayment?.paidAt).toBeDefined();

      // Check cost entry recorded in recovery_cost_entries (PAYMENT_PROCESSING)
      const costEntries = await listCostEntriesForCase(
        { db: app.db },
        { tenantId: tenant.id, caseId: testCase.id },
      );
      expect(costEntries).toHaveLength(1);
      expect(costEntries[0].category).toBe("PAYMENT_PROCESSING");
      expect(costEntries[0].amount).toBeGreaterThan(0n);
      expect(costEntries[0].currency).toBe("USD");

      // Check action updated to EXECUTED
      const updatedAction = await app.repos.findActionById(
        { db: app.db },
        { tenantId: tenant.id, actionId: action.id },
      );
      expect(updatedAction?.status).toBe("EXECUTED");
    });

    it("handles failure lifecycle with decline codes and fails action", async () => {
      const mockAdapter = new MockPaymentProvider({ defaultSuccessOnAttempt: 99 });
      const executionService = new PaymentExecutionService(
        app.db,
        app.repos,
        app.config,
        mockAdapter,
      );

      const action = await insertAction(
        { db: app.db },
        {
          tenantId: tenant.id,
          caseId: testCase.id,
          type: "RETRY_PAYMENT",
          parameters: { amount: 15000 },
          status: "PROPOSED",
          idempotencyKey: `${tenant.id}:${testCase.id}:RETRY_PAYMENT:1`,
        },
      );

      const result = await executionService.executeRetryPayment({
        tenantId: tenant.id,
        caseId: testCase.id,
        paymentId: testPayment.id,
        attemptNumber: 1,
        actionId: action.id,
      });

      expect(result.outcome).toBe("FAILED");

      // Check payment record updated to FAILED
      const updatedPayment = await findPaymentById(
        { db: app.db },
        { tenantId: tenant.id, paymentId: testPayment.id },
      );
      expect(updatedPayment?.status).toBe("FAILED");
      expect(updatedPayment?.failureCode).toBe("insufficient_funds");

      // Check action updated to FAILED
      const updatedAction = await app.repos.findActionById(
        { db: app.db },
        { tenantId: tenant.id, actionId: action.id },
      );
      expect(updatedAction?.status).toBe("FAILED");
    });
  });

  describe("3. Status Refresh Polling", () => {
    it("polls UNKNOWN status and transitions to final state with fee capture", async () => {
      const mockAdapter = new MockPaymentProvider();
      const refreshService = new PaymentRefreshService(
        app.db,
        app.repos,
        app.config,
        mockAdapter,
      );

      // Create an initial attempt row
      const attempt = await app.repos.createPaymentAttempt(
        { db: app.db },
        {
          tenantId: tenant.id,
          paymentId: testPayment.id,
          attemptNumber: 1,
          initiatedBy: "RECOVERY_WORKFLOW",
          idempotencyKey: `${tenant.id}:${testCase.id}:RETRY_PAYMENT:1`,
          status: "UNKNOWN",
          requestedAt: new Date(),
        },
      );

      // Configure provider to return SUCCEEDED when polled
      MockPaymentProvider.setOutcomeOverride(testPayment.providerPaymentId, {
        status: "SUCCEEDED",
        feeAmount: 330n,
        feeCurrency: "USD",
      });

      const polledResult = await refreshService.pollPaymentStatus({
        tenantId: tenant.id,
        caseId: testCase.id,
        paymentId: testPayment.id,
        attemptId: attempt.id,
        provider: "MOCK",
        providerPaymentId: testPayment.providerPaymentId,
        maxPolls: 3,
        initialIntervalMs: 50,
      });

      expect(polledResult.status).toBe("SUCCEEDED");

      // Verify payment and attempt updated to SUCCEEDED
      const updatedPayment = await findPaymentById(
        { db: app.db },
        { tenantId: tenant.id, paymentId: testPayment.id },
      );
      expect(updatedPayment?.status).toBe("SUCCEEDED");

      const attempts = await findPaymentAttemptsByPaymentId(
        { db: app.db },
        { tenantId: tenant.id, paymentId: testPayment.id },
      );
      expect(attempts[0].status).toBe("SUCCEEDED");

      // Cost entry recorded
      const costEntries = await listCostEntriesForCase(
        { db: app.db },
        { tenantId: tenant.id, caseId: testCase.id },
      );
      expect(costEntries.length).toBeGreaterThan(0);
      expect(costEntries[0].amount).toBe(330n);
    });

    it("gives up safely after maxPolls without crashing or marking falsely", async () => {
      const mockAdapter: PaymentProvider = {
        retryPayment: vi.fn(),
        createPaymentLink: vi.fn(),
        getPaymentStatus: vi.fn().mockResolvedValue({
          id: testPayment.providerPaymentId,
          status: "PENDING",
        }),
      };

      const refreshService = new PaymentRefreshService(
        app.db,
        app.repos,
        app.config,
        mockAdapter,
      );

      const polledResult = await refreshService.pollPaymentStatus({
        tenantId: tenant.id,
        caseId: testCase.id,
        paymentId: testPayment.id,
        provider: "MOCK",
        providerPaymentId: testPayment.providerPaymentId,
        maxPolls: 3,
        initialIntervalMs: 20,
      });

      // Still UNKNOWN / PENDING
      expect(polledResult.status).toBe("PENDING");
    });
  });

  describe("4. Payment REST APIs & RBAC", () => {
    it("GET /payments/:id returns payment with attempts timeline (VIEWER+)", async () => {
      // Create an attempt
      await app.repos.createPaymentAttempt(
        { db: app.db },
        {
          tenantId: tenant.id,
          paymentId: testPayment.id,
          attemptNumber: 1,
          initiatedBy: "RECOVERY_WORKFLOW",
          idempotencyKey: `${tenant.id}:${testCase.id}:RETRY_PAYMENT:1`,
          status: "FAILED",
          failureCode: "insufficient_funds",
          requestedAt: new Date(),
          resolvedAt: new Date(),
        },
      );

      const res = await app.inject({
        method: "GET",
        url: `/payments/${testPayment.id}`,
        headers: {
          cookie: `rr_session=${viewerCookie}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.payment.id).toBe(testPayment.id);
      expect(body.payment.amount).toBe("15000");
      expect(body.attempts).toHaveLength(1);
      expect(body.attempts[0].failureCode).toBe("insufficient_funds");
    });

    it("GET /payments/:id returns 404 for cross-tenant access", async () => {
      const otherTenant = await createTenant(
        { db: app.db },
        {
          name: "Other Tenant",
          slug: `other-tenant-${randomUUID().substring(0, 8)}`,
        },
      );
      const rawOtherKey = `rrk_${otherTenant.id.replace(/-/g, "").substring(0, 8)}_admin1234567890`;
      await createApiKey(
        { db: app.db },
        {
          tenantId: otherTenant.id,
          keyHash: sha256(rawOtherKey),
          name: "Other Admin",
        },
      );

      const res = await app.inject({
        method: "GET",
        url: `/payments/${testPayment.id}`,
        headers: {
          authorization: `Bearer ${rawOtherKey}`,
        },
      });

      expect(res.statusCode).toBe(404);
    });

    it("GET /payments/:id/status allows OPERATIONS+ and refreshes DB", async () => {
      MockPaymentProvider.setOutcomeOverride(testPayment.providerPaymentId, {
        status: "SUCCEEDED",
      });

      const res = await app.inject({
        method: "GET",
        url: `/payments/${testPayment.id}/status`,
        headers: {
          authorization: `Bearer ${adminApiKey}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.providerStatus).toBe("SUCCEEDED");
      expect(body.refreshed).toBe(true);

      // Verify payment status in DB was updated to SUCCEEDED
      const paymentInDb = await findPaymentById(
        { db: app.db },
        { tenantId: tenant.id, paymentId: testPayment.id },
      );
      expect(paymentInDb?.status).toBe("SUCCEEDED");
    });

    it("GET /payments/:id/status rejects VIEWER with 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/payments/${testPayment.id}/status`,
        headers: {
          cookie: `rr_session=${viewerCookie}`,
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it("POST /demo/mock/payments/:key/next-outcome sets scripted override", async () => {
      const key = "test_override_key_99";
      const res = await app.inject({
        method: "POST",
        url: `/demo/mock/payments/${key}/next-outcome`,
        payload: {
          status: "FAILED",
          failureCode: "stale_card",
          failureMessage: "Card expired in demo",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);

      const override = MockPaymentProvider.getOutcomeOverride(key);
      expect(override?.status).toBe("FAILED");
      expect(override?.failureCode).toBe("stale_card");
    });
  });
});
