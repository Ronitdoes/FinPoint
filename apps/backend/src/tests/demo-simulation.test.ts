import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app";
import { InProcessEventBus } from "@repo/integrations";
import {
  db,
  createTenant,
  createUser,
  createSession,
  findPaymentById,
  findCustomerById,
  findCaseById,
  type Tenant,
} from "@repo/db";
import { sha256, hashPassword } from "../lib/crypto";
import { apiConfig } from "@repo/config";
import {
  setDemoInjections,
  getDemoInjections,
  clearDemoInjections,
} from "../modules/demo/injections";
import { seedDemoData, resetDemoTenantData } from "@repo/db/seeds";

describe("Step 29 Integration: Demo Mode, Simulation Endpoints & Seed Data", { timeout: 45000 }, () => {
  let app: FastifyInstance;
  let eventBus: InProcessEventBus;
  let testTenant: Tenant;
  let adminCookie: string;
  let viewerCookie: string;
  let demoApiKey: string;
  let noDemoApiKey: string;

  beforeAll(async () => {
    eventBus = new InProcessEventBus();

    // 1. Create unique test tenant
    testTenant = await createTenant(
      { db },
      {
        name: `Demo Spec Tenant ${randomUUID().slice(0, 8)}`,
        slug: `demo-tenant-${randomUUID().slice(0, 8)}`,
      },
    );

    // 2. Create users with different roles for RBAC checks
    const passwordHash = await hashPassword("Admin12345!@#");

    const adminUser = await createUser(
      { db },
      {
        tenantId: testTenant.id,
        email: `admin.${randomUUID().slice(0, 6)}@example.com`,
        name: "Admin User",
        role: "ADMIN",
        status: "ACTIVE",
        passwordHash,
      },
    );

    const viewerUser = await createUser(
      { db },
      {
        tenantId: testTenant.id,
        email: `viewer.${randomUUID().slice(0, 6)}@example.com`,
        name: "Viewer User",
        role: "VIEWER",
        status: "ACTIVE",
        passwordHash,
      },
    );

    // 3. Create active sessions
    const rawAdminToken = `token_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: adminUser.id,
        tokenHash: sha256(rawAdminToken),
        expiresAt: new Date(Date.now() + 86400 * 1000),
      },
    );
    adminCookie = `rr_session=${rawAdminToken}`;

    const rawViewerToken = `token_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: viewerUser.id,
        tokenHash: sha256(rawViewerToken),
        expiresAt: new Date(Date.now() + 86400 * 1000),
      },
    );
    viewerCookie = `rr_session=${rawViewerToken}`;

    // 4. Create API keys
    const rawDemoKey = `rrk_demo_${randomUUID().replace(/-/g, "")}`;
    await db.insert((db as any).query ? (await import("@repo/db")).apiKeys : (await import("@repo/db")).apiKeys).values({
      tenantId: testTenant.id,
      name: "Demo Machine Key",
      keyHash: sha256(rawDemoKey),
      scopes: ["demo"],
      createdBy: adminUser.id,
    });
    demoApiKey = `Bearer ${rawDemoKey}`;

    const rawNoDemoKey = `rrk_nodemo_${randomUUID().replace(/-/g, "")}`;
    await db.insert((db as any).query ? (await import("@repo/db")).apiKeys : (await import("@repo/db")).apiKeys).values({
      tenantId: testTenant.id,
      name: "Regular Key",
      keyHash: sha256(rawNoDemoKey),
      scopes: ["events:write"],
      createdBy: adminUser.id,
    });
    noDemoApiKey = `Bearer ${rawNoDemoKey}`;

    // 5. Build application instance with InProcessEventBus
    app = await buildApp({
      eventBus,
      disableRateLimit: true,
      logger: false,
    });
    await app.ready();
  }, 45000);

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 500));
    if (app) {
      await clearDemoInjections((app as any).redisClient);
      await app.close();
    }
  });

  // ===========================================================================
  // 1. Simulation Endpoints Happy Path
  // ===========================================================================
  describe("Simulation Endpoints", () => {
    let capturedPaymentId: string;
    let capturedProviderPaymentId: string;

    it("POST /demo/payment-fail triggers signed loopback webhook and pipeline", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/demo/payment-fail",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        payload: {
          tenant_id: testTenant.id,
          customer_ref: "CUS-001",
          amount_minor: 1299900,
          provider: "STRIPE",
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.ok).toBe(true);
      expect(json.refs.provider).toBe("STRIPE");
      expect(json.refs.amountMinor).toBe(1299900);
      expect(json.refs.customerRef).toBe("CUS-001");
      expect(json.refs.webhookStatus).toBe("ACCEPTED");
      expect(json.refs.providerPaymentId).toBeDefined();

      capturedProviderPaymentId = json.refs.providerPaymentId;

      // Allow background consumers to process
      await new Promise((r) => setTimeout(r, 1000));

      // Assert payment entity in DB
      const foundPayment = await app.repos.findPaymentByProviderPaymentId(
        { db: app.db },
        {
          tenantId: testTenant.id,
          provider: "STRIPE",
          providerPaymentId: capturedProviderPaymentId,
        },
      );
      expect(foundPayment).toBeDefined();
      expect(foundPayment?.status).toBe("FAILED");
      capturedPaymentId = foundPayment!.id;
    });

    it("POST /demo/payment-succeed generates success webhook and signals workflow", async () => {
      expect(capturedPaymentId).toBeDefined();

      const res = await app.inject({
        method: "POST",
        url: "/demo/payment-succeed",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        payload: {
          tenant_id: testTenant.id,
          payment_id: capturedPaymentId,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.ok).toBe(true);
      expect(json.refs.paymentId).toBe(capturedPaymentId);
      expect(json.refs.webhookStatus).toBe("ACCEPTED");

      // Verify payment transitioned to SUCCEEDED
      await new Promise((r) => setTimeout(r, 500));
      const updatedPayment = await app.repos.findPaymentById(
        { db: app.db },
        { tenantId: testTenant.id, paymentId: capturedPaymentId },
      );
      expect(updatedPayment?.status).toBe("SUCCEEDED");
    });

    it("POST /demo/checkout-abandon initiates checkout.started and advances timer state", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/demo/checkout-abandon",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        payload: {
          tenant_id: testTenant.id,
          customer_ref: "CUS-002",
          cart_value_minor: 799900,
          age_minutes: 5,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.ok).toBe(true);
      expect(json.refs.customerRef).toBe("CUS-002");
      expect(json.refs.cartValueMinor).toBe(799900);
      expect(json.refs.status).toBe("ABANDONED");
      expect(json.refs.checkoutId).toBeDefined();

      // Verify checkout record status in DB
      const checkout = await app.repos.findCheckoutById(
        { db: app.db },
        { tenantId: testTenant.id, checkoutId: json.refs.checkoutId },
      );
      expect(checkout).toBeDefined();
      expect(checkout?.status).toBe("ABANDONED");
    });

    it("POST /demo/invoice-overdue dispatches signed overdue webhook", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/demo/invoice-overdue",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        payload: {
          tenant_id: testTenant.id,
          customer_ref: "CUS-003",
          amount_minor: 48000000,
          days_overdue: 7,
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.ok).toBe(true);
      expect(json.refs.customerRef).toBe("CUS-003");
      expect(json.refs.amountMinor).toBe(48000000);
      expect(json.refs.daysOverdue).toBe(7);
      expect(json.refs.webhookStatus).toBe("ACCEPTED");
    });
  });

  // ===========================================================================
  // 2. Auth, Scopes & Guard Tests
  // ===========================================================================
  describe("Demo Auth & Role Security", () => {
    it("allows execution with demo API key", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/demo/injections",
        headers: {
          authorization: demoApiKey,
        },
      });
      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.ok).toBe(true);
    });

    it("rejects API key without 'demo' scope (403)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/demo/injections",
        headers: {
          authorization: noDemoApiKey,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it("rejects VIEWER role session (403)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/demo/injections",
        headers: {
          cookie: viewerCookie,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it("rejects unauthenticated requests (401)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/demo/injections",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ===========================================================================
  // 3. Failure-Injection Switches & Duplicate Dedupe Proof
  // ===========================================================================
  describe("Failure Injection Switches", () => {
    it("manages toggle lifecycle in Redis (PATCH -> GET -> TTL)", async () => {
      // 1. Patch injection toggles
      const patchRes = await app.inject({
        method: "PATCH",
        url: "/demo/injections",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        payload: {
          simulate_llm_failure: true,
          simulate_duplicate_webhook: true,
        },
      });

      expect(patchRes.statusCode).toBe(200);
      const patchJson = JSON.parse(patchRes.body);
      expect(patchJson.ok).toBe(true);
      expect(patchJson.injections.simulate_llm_failure).toBe(true);
      expect(patchJson.injections.simulate_duplicate_webhook).toBe(true);
      expect(patchJson.ttlSeconds).toBe(900); // 15min

      // 2. Read back
      const getRes = await app.inject({
        method: "GET",
        url: "/demo/injections",
        headers: {
          cookie: adminCookie,
        },
      });

      expect(getRes.statusCode).toBe(200);
      const getJson = JSON.parse(getRes.body);
      expect(getJson.injections.simulate_llm_failure).toBe(true);
      expect(getJson.injections.simulate_duplicate_webhook).toBe(true);
    });

    it("proves deduplication live when simulate_duplicate_webhook is active", async () => {
      // Ensure duplicate switch is on
      await app.inject({
        method: "PATCH",
        url: "/demo/injections",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        payload: {
          simulate_duplicate_webhook: true,
        },
      });

      // Trigger simulation which dispatches 2 concurrent deliveries
      const res = await app.inject({
        method: "POST",
        url: "/demo/payment-fail",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        payload: {
          tenant_id: testTenant.id,
          customer_ref: "CUS-DEDUPE-TEST",
          amount_minor: 500000,
          provider: "STRIPE",
        },
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.ok).toBe(true);
      expect(json.refs.webhookStatus).toBe("ACCEPTED");

      // Turn off switch
      await app.inject({
        method: "PATCH",
        url: "/demo/injections",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        payload: {
          simulate_duplicate_webhook: false,
        },
      });
    });
  });

  // ===========================================================================
  // 4. Production & Mock Disabled Guards
  // ===========================================================================
  describe("Production & Mock Disabled Guards", () => {
    it("returns 410 MOCK_DISABLED when MOCK_PROVIDERS=false", async () => {
      const baseConfig = apiConfig();
      const mockDisabledConfig = {
        ...baseConfig,
        demo: {
          ...baseConfig.demo,
          mockProviders: false,
        },
      };

      const disabledApp = await buildApp({
        config: mockDisabledConfig,
        disableRateLimit: true,
        logger: false,
      });
      await disabledApp.ready();

      const res = await disabledApp.inject({
        method: "POST",
        url: "/demo/payment-fail",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        payload: {
          tenant_id: testTenant.id,
        },
      });

      expect(res.statusCode).toBe(410);
      const json = JSON.parse(res.body);
      expect(json.code).toBe("MOCK_DISABLED");

      await disabledApp.close();
    });

    it("omits demo routes in production build when MOCK_PROVIDERS=false (404)", async () => {
      const baseConfig = apiConfig();
      const prodConfig = {
        ...baseConfig,
        app: {
          ...baseConfig.app,
          env: "production" as const,
        },
        demo: {
          ...baseConfig.demo,
          mockProviders: false,
        },
      };

      const prodApp = await buildApp({
        config: prodConfig,
        disableRateLimit: true,
        logger: false,
      });
      await prodApp.ready();

      const res = await prodApp.inject({
        method: "POST",
        url: "/demo/payment-fail",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        payload: {},
      });

      expect(res.statusCode).toBe(404);
      await prodApp.close();
    });

    it("rejects minting demo-scoped API key when MOCK_PROVIDERS=false", async () => {
      const baseConfig = apiConfig();
      const mockDisabledConfig = {
        ...baseConfig,
        demo: {
          ...baseConfig.demo,
          mockProviders: false,
        },
      };

      const disabledApp = await buildApp({
        config: mockDisabledConfig,
        disableRateLimit: true,
        logger: false,
      });
      await disabledApp.ready();

      const res = await disabledApp.inject({
        method: "POST",
        url: "/admin/api-keys",
        headers: {
          cookie: adminCookie,
          "content-type": "application/json",
        },
        payload: {
          name: "Illegal Demo Key",
          scopes: ["demo"],
        },
      });

      expect(res.statusCode).toBe(422);
      await disabledApp.close();
    });
  });

  // ===========================================================================
  // 5. Deterministic Seeding & Reset Safety
  // ===========================================================================
  describe("Deterministic Seed & Reset", () => {
    it("produces identical content hash across two independent re-seeds", async () => {
      const demoSlug = `demo-hash-${randomUUID().slice(0, 6)}`;

      // First Seed
      const seed1 = await seedDemoData({
        tenantSlug: demoSlug,
        reset: true,
        seed: 0x12345,
      });

      expect(seed1.counts.customers).toBe(1000);
      expect(seed1.counts.payments).toBe(2500);
      expect(seed1.counts.activeCheckouts).toBe(250);
      expect(seed1.counts.abandonedCheckouts).toBe(150);
      expect(seed1.counts.overdueInvoices).toBe(180);
      expect(seed1.counts.recoveryCases).toBe(100);

      // Second Seed (with reset)
      const seed2 = await seedDemoData({
        tenantSlug: demoSlug,
        reset: true,
        seed: 0x12345,
      });

      expect(seed2.contentHash).toBe(seed1.contentHash);
    }, 120000);

    it("aborts reset on non-demo tenant slugs", async () => {
      await expect(
        resetDemoTenantData(app.db, "production-tenant-enterprise"),
      ).rejects.toThrow(/Safety guard violation/);
    });
  });
});
