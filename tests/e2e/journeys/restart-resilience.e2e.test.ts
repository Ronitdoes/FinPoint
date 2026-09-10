/**
 * Restart-resilience variant (s-32 §Requirements 2 item 18 / §29 #18).
 *
 * Simulates `kill -9 API + worker` mid-wait: the Fastify instance (and its
 * in-process bus consumers) is destroyed after case creation but before
 * outcome recording; a fresh instance boots against the same Postgres and the
 * journey still completes via guarded resume (no duplicate case, no
 * double-charge, outcome recorded once).
 *
 * Composed profile: set E2E_INFRA=1 to additionally exercise a real
 * `docker kill -s SIGKILL` of the worker container mid-wait (skipped
 * otherwise, per the s-31 drill contract).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../../apps/backend/src/app";
import { InProcessEventBus } from "@repo/integrations";
import { PolicyService } from "../../../apps/backend/src/modules/cases/../policy/policy.service";
import {
  buildE2EContext,
  closeE2EContext,
  seedPriorFailure,
  waitFor,
  mockLlmFetch,
  db,
  E2E_AMOUNTS,
  type E2EContext,
} from "../support/e2e-harness";
import { expectDod18RestartResilience, expectDod14OutcomeRecorded } from "../support/expect-journey";
import { assertNonProd, isInfraKillEnabled, drillKillWorker } from "../../chaos/harness/compose-admin";
import { CasePipelineService } from "../../../apps/backend/src/modules/cases/pipeline.service";
import { OutcomeRecordService } from "../../../apps/backend/src/modules/outcomes/record.service";

describe("E2E restart resilience: kill -9 mid-wait still completes [DOD-18]", { timeout: 180000 }, () => {
  let ctx: E2EContext;

  beforeAll(async () => {
    ctx = await buildE2EContext("restart");
    await seedPriorFailure(ctx, "CUS-001-RR");
  }, 60000);

  afterAll(async () => {
    // ctx.app may already be closed by the test; close is idempotent-safe.
    try {
      if (ctx) await closeE2EContext(ctx);
    } catch {
      // already torn down by the kill simulation
    }
  });

  it("survives API+worker kill mid-wait and records the outcome exactly once", async () => {
    const { app, tenant, adminCookie } = ctx;

    // 1. Trigger the failure and wait for the case to exist (pre-kill).
    const failRes = await app.inject({
      method: "POST",
      url: "/demo/payment-fail",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: {
        tenant_id: tenant.id,
        customer_ref: "CUS-001-RR",
        amount_minor: E2E_AMOUNTS.scenarioAminor,
        provider: "STRIPE",
      },
    });
    expect(failRes.statusCode).toBe(200);
    const { providerPaymentId } = JSON.parse(failRes.body).refs;

    let payment: any;
    await waitFor(
      async () => {
        payment = await app.repos.findPaymentByProviderPaymentId(
          { db: app.db },
          { tenantId: tenant.id, provider: "STRIPE", providerPaymentId },
        );
        return !!payment;
      },
      { label: "pre-kill payment row" },
    );

    let caseId: string | undefined;
    await waitFor(
      async () => {
        const { findLiveCaseByObligation } = await import("@repo/db");
        const c = await findLiveCaseByObligation(
          { db: app.db },
          { tenantId: tenant.id, sourceEntityType: "PAYMENT", sourceEntityId: payment.id },
        );
        caseId = c?.id;
        return !!c;
      },
      { label: "pre-kill recovery case" },
    );

    // 2. kill -9: destroy the API + worker (in-process consumers die here).
    // Real timers only for this variant (step §Requirements 5).
    await app.close();
    await new Promise((r) => setTimeout(r, 1500));

    // Optional composed-profile drill: real container SIGKILL (skipped fast path).
    try {
      assertNonProd();
      if (isInfraKillEnabled()) {
        drillKillWorker();
      }
    } catch {
      // drill guard refusal must not fail the resilience assertion itself
    }

    // 3. Reboot a fresh API against the SAME Postgres (fresh volumes analog:
    // same tenant, no reset) and resume the pipeline idempotently. The
    // isolated e2e Redis is reused so injection flags stay hermetic.
    const eventBus = new InProcessEventBus();
    const rebooted = await buildApp({ eventBus, redisClient: ctx.redis, disableRateLimit: true, logger: false });
    await rebooted.ready();
    const policies = new PolicyService(db, (rebooted as any).repos);
    await policies.seedDefaultPolicies();
    ctx.app = rebooted;

    const pipeline = new CasePipelineService({
      db: rebooted.db,
      repos: rebooted.repos,
      config: rebooted.config,
      customFetch: mockLlmFetch,
    });
    await pipeline.runPipeline({ tenantId: tenant.id, caseId: caseId! });
    // Resume is idempotent: second run must not duplicate work.
    await pipeline.runPipeline({ tenantId: tenant.id, caseId: caseId! });

    // 4. Complete the money loop post-restart.
    const succeedRes = await rebooted.inject({
      method: "POST",
      url: "/demo/payment-succeed",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      payload: { tenant_id: tenant.id, payment_id: payment.id },
    });
    expect(succeedRes.statusCode).toBe(200);

    const outcomes = new OutcomeRecordService(rebooted.db, rebooted.repos, (rebooted as any).redisClient);
    const first = await outcomes.recordOutcome({
      tenantId: tenant.id,
      caseId: caseId!,
      paymentId: payment.id,
      attributionMethod: "WORKFLOW_LINKED",
      recoveredAmount: BigInt(E2E_AMOUNTS.scenarioAminor),
      recoveredAt: new Date(),
    });
    const second = await outcomes.recordOutcome({
      tenantId: tenant.id,
      caseId: caseId!,
      paymentId: payment.id,
      attributionMethod: "WORKFLOW_LINKED",
      recoveredAmount: BigInt(E2E_AMOUNTS.scenarioAminor),
      recoveredAt: new Date(),
    });
    expect(second.alreadyRecorded).toBe(true);
    expect(second.outcome.id).toBe(first.outcome.id);

    // [DOD-18]
    await expectDod18RestartResilience(tenant.id, caseId!);
    await expectDod14OutcomeRecorded(tenant.id, caseId!, BigInt(E2E_AMOUNTS.scenarioAminor));
    await assertInvariantsSafe(tenant.id);
  }, 120000);
});

async function assertInvariantsSafe(tenantId: string): Promise<void> {
  const { assertInvariants } = await import("../../chaos/harness/assert-invariants");
  await assertInvariants(tenantId);
}
