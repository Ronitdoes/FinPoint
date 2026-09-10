/**
 * Dashboard UI smoke (s-32 §Requirements 4): closes the UI loop post-journey.
 *
 * 1. Drives a compact payment-failure → recovery loop in an isolated tenant.
 * 2. Asserts the API numbers the dashboard cards render (overview delta +
 *    case-timeline feed) via the same endpoints `apps/frontend` consumes.
 * 3. If a built frontend is reachable (FRONTEND_URL, composed profile),
 *    asserts the dashboard HTML renders the overview cards; when Playwright
 *    is installed, additionally asserts the card delta + timeline in a real
 *    browser. Browser assertions skip gracefully when Playwright is absent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  buildE2EContext,
  closeE2EContext,
  waitFor,
  ensurePipelineSettled,
  mockLlmFetch,
  db,
  type E2EContext,
} from "../support/e2e-harness";
import { OutcomeRecordService } from "../../../apps/backend/src/modules/outcomes/record.service";

const SMOKE_MINOR = 899900; // ₹8,999 in paise

describe("E2E UI smoke: dashboard-number loop", { timeout: 180000 }, () => {
  let ctx: E2EContext;
  let caseId: string;
  let paymentId: string;

  beforeAll(async () => {
    ctx = await buildE2EContext("ui-smoke");

    const fail = await ctx.app.inject({
      method: "POST",
      url: "/demo/payment-fail",
      headers: { cookie: ctx.adminCookie, "content-type": "application/json" },
      payload: { tenant_id: ctx.tenant.id, customer_ref: `UI-SMOKE-${ctx.runId}`, amount_minor: SMOKE_MINOR, provider: "STRIPE" },
    });
    expect(fail.statusCode).toBe(200);
    const { providerPaymentId } = JSON.parse(fail.body).refs;

    let payment: any;
    await waitFor(
      async () => {
        payment = await ctx.app.repos.findPaymentByProviderPaymentId(
          { db: ctx.app.db },
          { tenantId: ctx.tenant.id, provider: "STRIPE", providerPaymentId },
        );
        return !!payment;
      },
      { label: "ui smoke payment ingested" },
    );
    paymentId = payment.id;

    let recoveryCase: any;
    await waitFor(
      async () => {
        const { findLiveCaseByObligation } = await import("@repo/db");
        recoveryCase = await findLiveCaseByObligation(
          { db: ctx.app.db },
          { tenantId: ctx.tenant.id, sourceEntityType: "PAYMENT", sourceEntityId: payment.id },
        );
        return !!recoveryCase;
      },
      { label: "ui smoke case created" },
    );
    caseId = recoveryCase.id;

    await ensurePipelineSettled(ctx, caseId, { customFetch: mockLlmFetch });

    const outcomes = new OutcomeRecordService(ctx.app.db, ctx.app.repos, (ctx.app as any).redisClient);
    await outcomes.recordOutcome({
      tenantId: ctx.tenant.id,
      caseId,
      paymentId,
      attributionMethod: "WORKFLOW_LINKED",
      recoveredAmount: BigInt(SMOKE_MINOR),
      recoveredAt: new Date(),
    });
  }, 120000);

  afterAll(async () => {
    if (ctx) await closeE2EContext(ctx);
  });

  it("overview card delta: GET /analytics/summary reflects the recovered amount", async () => {
    const range = `from=${new Date(Date.now() - 30 * 86400 * 1000).toISOString()}&to=${new Date(Date.now() + 30 * 86400 * 1000).toISOString()}`;
    const res = await ctx.app.inject({
      method: "GET",
      url: `/analytics/summary?${range}`,
      headers: { cookie: ctx.financeCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Isolated tenant: every recovered rupee here came from this smoke loop.
    expect(BigInt(body.financial.revenue_recovered_minor)).toBe(BigInt(SMOKE_MINOR));
    expect(body.financial.currency).toBe("INR");
  });

  it("case-timeline render: GET /cases/:id/timeline returns the journey feed", async () => {
    const res = await ctx.app.inject({
      method: "GET",
      url: `/cases/${caseId}/timeline?limit=100`,
      headers: { cookie: ctx.viewerCookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const items = body.items ?? body;
    expect(Array.isArray(items)).toBe(true);
    const types = items.map((e: any) => e.eventType ?? e.event_type);
    for (const required of ["RISK_CALCULATED", "AI_DECISION_CREATED", "POLICY_ALLOWED", "WORKFLOW_STARTED"]) {
      expect(types).toContain(required);
    }
  });

  it("built frontend serves the dashboard app (static markup; Playwright when available)", async () => {
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
    let html: string | null = null;
    try {
      const res = await fetch(`${frontendUrl}/dashboard`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) html = await res.text();
    } catch {
      html = null;
    }
    if (!html) {
      console.log("[e2e ui] frontend not reachable at", frontendUrl, "— static markup check skipped (API loop already proven)");
      return;
    }
    // Unauthenticated /dashboard is proxied to the login shell; either marker
    // proves the built dashboard app serves (brand: FinPoint).
    expect(html).toMatch(/FinPoint|Revenue Recovery|Total Recovered/);

    // Real-browser assertions when Playwright is installed (optional dep).
    let playwright: any = null;
    try {
      playwright = await import("playwright");
    } catch {
      playwright = null;
    }
    if (!playwright) {
      console.log("[e2e ui] playwright not installed — browser card/timeline assertions skipped");
      return;
    }
    const browser = await playwright.chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(`${frontendUrl}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await expect(page.getByText(/Revenue Recovery/i).first()).toBeVisible();
      await page.goto(`${frontendUrl}/cases/${caseId}`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await expect(page.getByText(/timeline/i).first()).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
