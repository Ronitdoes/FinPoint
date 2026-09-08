/**
 * Chaos scenario: payment succeeds after workflow retry already gave up
 * (Spec 01 §21).
 *
 * The case sits STOPPED (MAX_RETRIES) with no outcome; the customer then pays
 * out-of-band. Acceptance: the attribution sweeper records the outcome via
 * the s-26 ATTRIBUTION_WINDOW path while the case stays STOPPED (no state
 * resurrection, no duplicate outcome on re-sweep).
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  db,
  findCaseById,
  findOutcomeByCaseId,
  transitionCaseStatus,
  updatePaymentStatus,
} from "@repo/db";
import { AttributionSweeper } from "../../../apps/backend/src/modules/outcomes/attribution.sweeper";
import { resetChaosHarness } from "../harness/fault-points";
import { assertInvariants } from "../harness/assert-invariants";
import {
  buildChaosApp,
  counterValue,
  createChaosPaymentCase,
} from "../harness/seed";

describe("chaos: late payment success after STOPPED", { timeout: 60000 }, () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ app } = await buildChaosApp());
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  afterEach(() => {
    resetChaosHarness();
  });

  it("STOPPED case + out-of-band success → attribution outcome, case stays STOPPED", async () => {
    const { tenant, payment, recoveryCase } = await createChaosPaymentCase("latesuccess");
    const tenantId = tenant.id;

    // Workflow exhausted retries and stopped the case with no outcome.
    const stopped = await transitionCaseStatus(
      { db },
      {
        tenantId,
        caseId: recoveryCase.id,
        from: ["IN_PROGRESS"],
        to: "STOPPED",
        reason: "MAX_RETRIES",
      },
    );
    expect(stopped?.status).toBe("STOPPED");
    expect(
      await findOutcomeByCaseId({ db }, { tenantId, caseId: recoveryCase.id }),
    ).toBeNull();

    // Customer pays out-of-band after the stop.
    const paid = await updatePaymentStatus(
      { db },
      { tenantId, paymentId: payment.id, status: "SUCCEEDED", paidAt: new Date() },
    );
    expect(paid?.status).toBe("SUCCEEDED");

    const matchesBefore = await counterValue("attribution_sweeper_matches_total");

    const sweeper = new AttributionSweeper(app.db, app.repos);
    const sweep = await sweeper.runSweep({ tenantId, batchSize: 10 });
    expect(sweep.casesAudited).toBeGreaterThanOrEqual(1);
    expect(sweep.casesAttributed).toBe(1);
    expect(sweep.attributedCaseIds).toContain(recoveryCase.id);

    // Outcome recorded via the attribution window…
    const outcome = await findOutcomeByCaseId(
      { db },
      { tenantId, caseId: recoveryCase.id },
    );
    expect(outcome).toBeDefined();
    expect(outcome!.paymentId).toBe(payment.id);
    expect(outcome!.attributionMethod).toBe("ATTRIBUTION_WINDOW");

    // …while the case stays STOPPED (no resurrection).
    const still = await findCaseById({ db }, { tenantId, caseId: recoveryCase.id });
    expect(still?.status).toBe("STOPPED");

    expect(await counterValue("attribution_sweeper_matches_total") - matchesBefore).toBe(1);

    // Re-sweep is an idempotent no-op: no duplicate outcome.
    const second = await sweeper.runSweep({ tenantId, batchSize: 10 });
    expect(second.casesAttributed).toBe(0);

    await assertInvariants(tenantId);
  });
});
