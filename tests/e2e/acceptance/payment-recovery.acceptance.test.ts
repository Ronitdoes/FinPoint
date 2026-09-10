/**
 * Payment-recovery acceptance blocks — spec 03 §8 verbatim (s-32 §Requirements 3).
 *
 * Given/When/Then phrasing is preserved in test titles; each maps to
 * AC-PAY-1..4 in TRACEABILITY.md §3.
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

describe("AC payment recovery (spec 03 §8)", { timeout: 180000 }, () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await buildE2EContext("ac-pay");
  }, 60000);

  afterAll(async () => {
    if (ctx) await closeE2EContext(ctx);
  });

  it("AC-PAY-1 — Given a failed payment, When the event enters the gateway, Then one recovery case is created", async () => {
    const ref = `AC-PAY-1-${ctx.runId}`;
    const res = await ctx.app.inject({
      method: "POST",
      url: "/demo/payment-fail",
      headers: { cookie: ctx.adminCookie, "content-type": "application/json" },
      payload: { tenant_id: ctx.tenant.id, customer_ref: ref, amount_minor: 250000, provider: "STRIPE" },
    });
    expect(res.statusCode).toBe(200);
    const { providerPaymentId } = JSON.parse(res.body).refs;

    let payment: any;
    await waitFor(
      async () => {
        payment = await ctx.app.repos.findPaymentByProviderPaymentId(
          { db: ctx.app.db },
          { tenantId: ctx.tenant.id, provider: "STRIPE", providerPaymentId },
        );
        return !!payment;
      },
      { label: "AC-PAY-1 payment ingested" },
    );

    let found: any;
    await waitFor(
      async () => {
        const { findLiveCaseByObligation } = await import("@repo/db");
        found = await findLiveCaseByObligation(
          { db: ctx.app.db },
          { tenantId: ctx.tenant.id, sourceEntityType: "PAYMENT", sourceEntityId: payment.id },
        );
        return !!found;
      },
      { label: "AC-PAY-1 recovery case created" },
    );
    expect(found.caseNumber).toBeGreaterThan(0);
  }, 60000);

  it("AC-PAY-2 — Given duplicate webhook, When same event is received again, Then no duplicate case is created", async () => {
    const ref = `AC-PAY-2-${ctx.runId}`;
    const first = await ctx.app.inject({
      method: "POST",
      url: "/demo/payment-fail",
      headers: { cookie: ctx.adminCookie, "content-type": "application/json" },
      payload: { tenant_id: ctx.tenant.id, customer_ref: ref, amount_minor: 310000, provider: "STRIPE" },
    });
    expect(first.statusCode).toBe(200);
    const { providerPaymentId } = JSON.parse(first.body).refs;

    let payment: any;
    await waitFor(
      async () => {
        payment = await ctx.app.repos.findPaymentByProviderPaymentId(
          { db: ctx.app.db },
          { tenantId: ctx.tenant.id, provider: "STRIPE", providerPaymentId },
        );
        return !!payment;
      },
      { label: "AC-PAY-2 payment ingested" },
    );
    await waitFor(
      async () => {
        const { findLiveCaseByObligation } = await import("@repo/db");
        return !!(await findLiveCaseByObligation(
          { db: ctx.app.db },
          { tenantId: ctx.tenant.id, sourceEntityType: "PAYMENT", sourceEntityId: payment.id },
        ));
      },
      { label: "AC-PAY-2 first case exists" },
    );

    // Replay the same normalized envelope anchor: second insert is a no-op.
    const { insertEventIfNew, listCases } = await import("@repo/db");
    const { randomUUID } = await import("node:crypto");
    const externalEventId = `evt_ac_pay2_${ctx.runId}`;
    await insertEventIfNew(
      { db: ctx.app.db },
      {
        tenantId: ctx.tenant.id, source: "STRIPE", externalEventId, type: "payment.failed",
        customerId: payment.customerId, entityType: "PAYMENT", entityId: payment.id,
        rawPayload: {}, payload: {}, correlationId: randomUUID(),
      },
    );
    const replay = await insertEventIfNew(
      { db: ctx.app.db },
      {
        tenantId: ctx.tenant.id, source: "STRIPE", externalEventId, type: "payment.failed",
        customerId: payment.customerId, entityType: "PAYMENT", entityId: payment.id,
        rawPayload: {}, payload: {}, correlationId: randomUUID(),
      },
    );
    expect(replay.duplicate).toBe(true);

    const cases = (await listCases({ db: ctx.app.db }, { tenantId: ctx.tenant.id, limit: 500 })).filter(
      (c: any) => c.sourceEntityId === payment.id,
    );
    expect(cases.length).toBe(1);
  }, 60000);

  it("AC-PAY-3 — Given retry count = 3, When AI recommends another retry, Then policy rejects it", async () => {
    // Deterministic policy contract: the same pure `evaluate` the service
    // delegates to, with a retry-exhausted case context (POL-MAXRETRY).
    const { evaluate, createDefaultActiveRules } = await import("../../../packages/policy/src/index");
    const result = evaluate(
      {
        case: { id: "case-ac-pay-3", tenant_id: ctx.tenant.id, retry_count: 3 } as any,
        customer: { opted_out: false } as any,
        decision: { diagnosis_confidence: 0.9 } as any,
        actions: [{ type: "RETRY_PAYMENT", params: { attempt_number: 4 } }] as any,
        counters: { whatsapp_sent_7d: 0, email_sent_14d: 0, sms_sent_7d: 0 } as any,
        policy_version_ids: [],
      } as any,
      createDefaultActiveRules(),
    );
    expect(result.result).toBe("REJECTED");
    expect(result.rejections.some((r: any) => r.rule_code === "POL-MAXRETRY")).toBe(true);
    expect(result.effective_actions.length).toBe(0);
  });

  it("AC-PAY-4 — Given successful retry, When payment succeeds, Then workflow closes, And outcome records recovered amount", async () => {
    const ref = `AC-PAY-4-${ctx.runId}`;
    const res = await ctx.app.inject({
      method: "POST",
      url: "/demo/payment-fail",
      headers: { cookie: ctx.adminCookie, "content-type": "application/json" },
      payload: { tenant_id: ctx.tenant.id, customer_ref: ref, amount_minor: 420000, provider: "STRIPE" },
    });
    expect(res.statusCode).toBe(200);
    const { providerPaymentId } = JSON.parse(res.body).refs;

    let payment: any;
    await waitFor(
      async () => {
        payment = await ctx.app.repos.findPaymentByProviderPaymentId(
          { db: ctx.app.db },
          { tenantId: ctx.tenant.id, provider: "STRIPE", providerPaymentId },
        );
        return !!payment;
      },
      { label: "AC-PAY-4 payment ingested" },
    );

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
      { label: "AC-PAY-4 case created" },
    );

    await ensurePipelineSettled(ctx, recoveryCase.id, { customFetch: mockLlmFetch });

    const succeed = await ctx.app.inject({
      method: "POST",
      url: "/demo/payment-succeed",
      headers: { cookie: ctx.adminCookie, "content-type": "application/json" },
      payload: { tenant_id: ctx.tenant.id, payment_id: payment.id },
    });
    expect(succeed.statusCode).toBe(200);

    const outcomes = new OutcomeRecordService(ctx.app.db, ctx.app.repos, (ctx.app as any).redisClient);
    const recorded = await outcomes.recordOutcome({
      tenantId: ctx.tenant.id,
      caseId: recoveryCase.id,
      paymentId: payment.id,
      attributionMethod: "WORKFLOW_LINKED",
      recoveredAmount: 420000n,
      recoveredAt: new Date(),
    });
    expect(recorded.outcome).toBeTruthy();

    const { findOutcomeByCaseId, findCaseById } = await import("@repo/db");
    const outcome = await findOutcomeByCaseId(
      { db: ctx.app.db }, { tenantId: ctx.tenant.id, caseId: recoveryCase.id },
    );
    expect(BigInt(outcome!.recoveredAmount as any)).toBe(420000n);
    const closed = await findCaseById(
      { db: ctx.app.db }, { tenantId: ctx.tenant.id, caseId: recoveryCase.id },
    );
    expect(closed!.status).toBe("RECOVERED");
    expect(outcome!.attributionMethod).toBe("WORKFLOW_LINKED");
  }, 90000);
});
