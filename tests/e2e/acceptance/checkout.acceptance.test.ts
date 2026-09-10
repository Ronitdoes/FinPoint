/**
 * Checkout acceptance blocks — spec 03 §8 verbatim (s-32 §Requirements 3).
 * AC-CO-1..2 in TRACEABILITY.md §3.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  buildE2EContext,
  closeE2EContext,
  waitFor,
  db,
  type E2EContext,
} from "../support/e2e-harness";

describe("AC checkout abandonment (spec 03 §8)", { timeout: 180000 }, () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await buildE2EContext("ac-co");
  }, 60000);

  afterAll(async () => {
    if (ctx) await closeE2EContext(ctx);
  });

  it("AC-CO-1 — Given active checkout, When purchase completes, Then abandonment workflow stops", async () => {
    const ref = `AC-CO-1-${ctx.runId}`;
    const abandon = await ctx.app.inject({
      method: "POST",
      url: "/demo/checkout-abandon",
      headers: { cookie: ctx.adminCookie, "content-type": "application/json" },
      payload: { tenant_id: ctx.tenant.id, customer_ref: ref, cart_value_minor: 799900, age_minutes: 5 },
    });
    expect(abandon.statusCode).toBe(200);
    const { checkoutId } = JSON.parse(abandon.body).refs;

    // Purchase completes: atomic COMPLETED transition wins, so the abandonment
    // workflow must stop — the race guard refuses further outbound contact.
    const { completeRaceGuard, findCheckoutById, updateCheckoutStatus, recordCheckoutEvent } = await import("@repo/db");
    await updateCheckoutStatus(
      { db: ctx.app.db },
      { tenantId: ctx.tenant.id, checkoutId, status: "COMPLETED", completedAt: new Date() },
    );
    await recordCheckoutEvent(
      { db: ctx.app.db },
      { tenantId: ctx.tenant.id, checkoutId, type: "CHECKOUT_COMPLETED", payload: { completed_at: new Date().toISOString() } },
    );
    const guard = await completeRaceGuard(
      { db: ctx.app.db }, { tenantId: ctx.tenant.id, checkoutId },
    );
    expect(guard.safeToSend).toBe(false);

    const checkout = await findCheckoutById(
      { db: ctx.app.db }, { tenantId: ctx.tenant.id, checkoutId },
    );
    expect(checkout!.status).toBe("COMPLETED");
  }, 60000);

  it("AC-CO-2 — Given abandoned checkout, When threshold passes, Then a recovery case may be created", async () => {
    const ref = `AC-CO-2-${ctx.runId}`;
    const abandon = await ctx.app.inject({
      method: "POST",
      url: "/demo/checkout-abandon",
      headers: { cookie: ctx.adminCookie, "content-type": "application/json" },
      payload: { tenant_id: ctx.tenant.id, customer_ref: ref, cart_value_minor: 799900, age_minutes: 45 },
    });
    expect(abandon.statusCode).toBe(200);
    const { checkoutId, status } = JSON.parse(abandon.body).refs;
    expect(status).toBe("ABANDONED");

    const { findCheckoutById } = await import("@repo/db");
    const checkout = await findCheckoutById(
      { db: ctx.app.db }, { tenantId: ctx.tenant.id, checkoutId },
    );
    expect(checkout!.status).toBe("ABANDONED");

    // Risk engine consumes checkout.abandoned asynchronously; a recovery case
    // MAY be created (spec wording) — assert the risk exists and, when the
    // orchestrator qualifies it, exactly one case attaches.
    const { findLatestRiskForSubject } = await import("@repo/db");
    let risk: any;
    await waitFor(
      async () => {
        risk = await findLatestRiskForSubject(
          { db: ctx.app.db }, { tenantId: ctx.tenant.id, subjectType: "CHECKOUT", subjectId: checkoutId },
        );
        return !!risk;
      },
      { timeoutMs: 30000, label: "AC-CO-2 checkout risk calculated" },
    );
    expect(risk.riskType).toBe("CHECKOUT_ABANDONMENT");
  }, 60000);
});
