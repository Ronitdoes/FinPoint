/**
 * High-value invoice acceptance block — spec 03 §8 verbatim (s-32 §Requirements 3).
 * AC-INV-1 in TRACEABILITY.md §3.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  buildE2EContext,
  closeE2EContext,
  waitFor,
  ensurePipelineSettled,
  installE2ELlmStub,
  db,
  type E2EContext,
} from "../support/e2e-harness";

/** Mock LLM recommending an incentive on a high-value invoice (approval path). */
const incentiveLlmFetch: any = async () =>
  new Response(
    JSON.stringify({
      id: "e2e-inv-choice-1",
      model: "gpt-4o-mini",
      choices: [
        {
          message: {
            role: "assistant",
            content: JSON.stringify({
              diagnosis: { cause: "waiting_for_payday", confidence: 0.81, rationale: "Enterprise AP cycle delay" },
              actions: [
                {
                  type: "OFFER_INCENTIVE",
                  delay_hours: 1,
                  params: { kind: "DISCOUNT", amount_minor: 100000 },
                },
              ],
              stop_conditions: ["PAYMENT_SUCCEEDED", "CASE_DISPUTED"],
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

describe("AC high-value invoice approval (spec 03 §8)", { timeout: 180000 }, () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await buildE2EContext("ac-inv");
    // Background consumers must recommend the incentive too, so the approval
    // path is deterministic whichever pipeline run wins the guarded race.
    installE2ELlmStub(incentiveLlmFetch);
  }, 60000);

  afterAll(async () => {
    if (ctx) await closeE2EContext(ctx);
  });

  it("AC-INV-1 — Given high-value overdue invoice, When AI recommends incentive, Then policy requires human approval", async () => {
    const ref = `AC-INV-1-${ctx.runId}`;
    const overdue = await ctx.app.inject({
      method: "POST",
      url: "/demo/invoice-overdue",
      headers: { cookie: ctx.adminCookie, "content-type": "application/json" },
      payload: { tenant_id: ctx.tenant.id, customer_ref: ref, amount_minor: 48000000, days_overdue: 7 },
    });
    expect(overdue.statusCode).toBe(200);

    // Wait for the invoice-anchored recovery case via risk → orchestrator.
    let recoveryCase: any;
    await waitFor(
      async () => {
        const { listCases } = await import("@repo/db");
        const found = (await listCases({ db: ctx.app.db }, { tenantId: ctx.tenant.id, limit: 500 })).filter(
          (c: any) => c.riskType === "INVOICE_OVERDUE" && c.status !== "STOPPED",
        );
        recoveryCase = found[0];
        return !!recoveryCase;
      },
      { timeoutMs: 45000, label: "AC-INV-1 invoice case created" },
    );

    await ensurePipelineSettled(ctx, recoveryCase.id, { customFetch: incentiveLlmFetch });

    const { findCaseById, listHumanTasksForCase, listPolicyEvaluationsForCase } = await import("@repo/db");
    const escalated = await findCaseById(
      { db: ctx.app.db }, { tenantId: ctx.tenant.id, caseId: recoveryCase.id },
    );
    expect(escalated!.status).toBe("ESCALATED");
    expect(escalated!.statusReason).toBe("POLICY_REQUIRES_APPROVAL");

    const evaluations = await listPolicyEvaluationsForCase(
      { db: ctx.app.db }, { tenantId: ctx.tenant.id, caseId: recoveryCase.id },
    );
    expect(evaluations.some((e: any) => e.result === "REQUIRE_APPROVAL")).toBe(true);

    const tasks = await listHumanTasksForCase(
      { db: ctx.app.db }, { tenantId: ctx.tenant.id, caseId: recoveryCase.id },
    );
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0]!.type).toBe("APPROVAL");
    expect(tasks[0]!.status).toBe("PENDING");
  }, 90000);
});
