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
  createCustomer,
  createInvoice,
  createCase,
  createPromiseToPay,
  createPayment,
  findPromiseById,
  type Tenant,
} from "@repo/db";
import { sha256 } from "../lib/crypto";

describe("Step 24 Integration: Promises to Pay API & Reconciliation", { timeout: 60000 }, () => {
  let app: FastifyInstance;
  let eventBus: InProcessEventBus;
  let tenantA: Tenant;
  let tenantB: Tenant;

  let viewerCookie: string;
  let financeCookie: string;
  let supportCookie: string;
  let financeUserId: string;

  beforeAll(async () => {
    eventBus = new InProcessEventBus();
    app = await buildApp({
      customDb: db,
      eventBus,
      disableRateLimit: true,
    });
    await app.ready();

    // 1. Seed Tenant A & Tenant B
    tenantA = await createTenant(
      { db },
      { name: `Tenant PTP A ${randomUUID()}`, slug: `tenant-ptp-a-${randomUUID().slice(0, 8)}` },
    );

    tenantB = await createTenant(
      { db },
      { name: `Tenant PTP B ${randomUUID()}`, slug: `tenant-ptp-b-${randomUUID().slice(0, 8)}` },
    );

    // 2. Seed Users & Sessions for Tenant A
    const viewerUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `viewer-${randomUUID().slice(0, 6)}@test.com`,
        passwordHash: "hashed",
        name: "Viewer User",
        role: "VIEWER",
      },
    );
    const viewerSessionToken = `sess_viewer_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: viewerUser.id,
        tokenHash: sha256(viewerSessionToken),
        expiresAt: new Date(Date.now() + 86400000),
      },
    );
    viewerCookie = `rr_session=${viewerSessionToken}`;

    const financeUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `finance-${randomUUID().slice(0, 6)}@test.com`,
        passwordHash: "hashed",
        name: "Finance User",
        role: "FINANCE",
      },
    );
    financeUserId = financeUser.id;
    const financeSessionToken = `sess_fin_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: financeUser.id,
        tokenHash: sha256(financeSessionToken),
        expiresAt: new Date(Date.now() + 86400000),
      },
    );
    financeCookie = `rr_session=${financeSessionToken}`;

    const supportUser = await createUser(
      { db },
      {
        tenantId: tenantA.id,
        email: `support-${randomUUID().slice(0, 6)}@test.com`,
        passwordHash: "hashed",
        name: "Support User",
        role: "SUPPORT",
      },
    );
    const supportSessionToken = `sess_support_${randomUUID()}`;
    await createSession(
      { db },
      {
        userId: supportUser.id,
        tokenHash: sha256(supportSessionToken),
        expiresAt: new Date(Date.now() + 86400000),
      },
    );
    supportCookie = `rr_session=${supportSessionToken}`;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("1. GET /promises-to-pay lists promises with status and customer filter (role >= VIEWER)", async () => {
    const customer = await createCustomer(
      { db },
      {
        tenantId: tenantA.id,
        externalRef: `ext-${randomUUID()}`,
        name: "PTP Customer",
        email: `ptp-${randomUUID().slice(0, 6)}@example.com`,
      },
    );

    const invoice = await createInvoice(
      { db },
      {
        tenantId: tenantA.id,
        customerId: customer.id,
        number: `INV-${randomUUID().slice(0, 8)}`,
        amount: 2500000n,
        currency: "INR",
        dueAt: new Date(),
        status: "OVERDUE",
      },
    );

    const caseRow = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: customer.id,
        riskType: "INVOICE_OVERDUE",
        sourceEntityType: "INVOICE",
        sourceEntityId: invoice.id,
        amountAtRisk: 2500000n,
        currency: "INR",
        riskScore: 70,
        status: "IN_PROGRESS",
      },
    );

    const ptp = await createPromiseToPay(
      { db },
      {
        tenantId: tenantA.id,
        caseId: caseRow.id,
        promisedAmount: 2500000n,
        currency: "INR",
        promisedByDate: "2026-09-15",
        status: "MADE",
      },
    );

    // Fetch as VIEWER
    const res = await app.inject({
      method: "GET",
      url: `/promises-to-pay?customer_id=${customer.id}`,
      headers: {
        cookie: viewerCookie,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toBeDefined();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].id).toBe(ptp.id);
  });

  it("2. POST /promises-to-pay/:id/mark-honored reconciles payment (role >= FINANCE)", async () => {
    const customer = await createCustomer(
      { db },
      {
        tenantId: tenantA.id,
        externalRef: `ext-${randomUUID()}`,
        name: "PTP Customer 2",
        email: `ptp2-${randomUUID().slice(0, 6)}@example.com`,
      },
    );

    const invoice = await createInvoice(
      { db },
      {
        tenantId: tenantA.id,
        customerId: customer.id,
        number: `INV-${randomUUID().slice(0, 8)}`,
        amount: 1000000n,
        currency: "INR",
        dueAt: new Date(),
        status: "OVERDUE",
      },
    );

    const caseRow = await createCase(
      { db },
      {
        tenantId: tenantA.id,
        customerId: customer.id,
        riskType: "INVOICE_OVERDUE",
        sourceEntityType: "INVOICE",
        sourceEntityId: invoice.id,
        amountAtRisk: 1000000n,
        currency: "INR",
        riskScore: 60,
        status: "IN_PROGRESS",
      },
    );

    const ptp = await createPromiseToPay(
      { db },
      {
        tenantId: tenantA.id,
        caseId: caseRow.id,
        promisedAmount: 1000000n,
        currency: "INR",
        promisedByDate: "2026-09-20",
        status: "MADE",
      },
    );

    const payment = await createPayment(
      { db },
      {
        tenantId: tenantA.id,
        customerId: customer.id,
        providerPaymentId: `pi_${randomUUID().slice(0, 12)}`,
        amount: 1000000n,
        currency: "INR",
        status: "SUCCEEDED",
        provider: "STRIPE",
        occurredAt: new Date(),
      },
    );

    // Attempt mark-honored as SUPPORT (should be 403 Forbidden)
    const supportRes = await app.inject({
      method: "POST",
      url: `/promises-to-pay/${ptp.id}/mark-honored`,
      headers: {
        cookie: supportCookie,
      },
      payload: {
        payment_id: payment.id,
      },
    });
    expect(supportRes.statusCode).toBe(403);

    // Attempt mark-honored as FINANCE
    const financeRes = await app.inject({
      method: "POST",
      url: `/promises-to-pay/${ptp.id}/mark-honored`,
      headers: {
        cookie: financeCookie,
      },
      payload: {
        payment_id: payment.id,
      },
    });

    expect(financeRes.statusCode).toBe(200);
    const body = JSON.parse(financeRes.body);
    expect(body.success).toBe(true);
    expect(body.promise.status).toBe("HONORED");
    expect(body.promise.honored_payment_id).toBe(payment.id);

    // Verify DB update
    const dbPtp = await findPromiseById({ db }, { tenantId: tenantA.id, promiseId: ptp.id });
    expect(dbPtp?.status).toBe("HONORED");
    expect(dbPtp?.honoredPaymentId).toBe(payment.id);
  });
});
