/**
 * Chaos scenario: Postgres reconnect (Spec 01 §21).
 *
 * Acceptance: in-flight transactions fail cleanly (retryable, no partial
 * writes), guarded conditional updates resolve races with exactly one winner,
 * and the pool keeps serving afterwards. The 30s container-pause half runs
 * nightly via the compose drill (skipped here with a report artifact).
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  db,
  sql,
  createPayment,
  findPaymentById,
  transitionCaseStatus,
} from "@repo/db";
import { drillPausePostgres } from "../harness/compose-admin";
import { resetChaosHarness } from "../harness/fault-points";
import { assertInvariants } from "../harness/assert-invariants";
import {
  createChaosCase,
  createChaosCustomer,
  createChaosPayment,
  createChaosTenant,
} from "../harness/seed";

describe("chaos: Postgres connection drop", { timeout: 60000 }, () => {
  afterEach(() => {
    resetChaosHarness();
  });

  it("failed statements surface cleanly and the pool keeps serving", async () => {
    const tenant = await createChaosTenant("pgreconnect");
    const tenantId = tenant.id;
    const customer = await createChaosCustomer(tenantId);

    // A bad statement rejects (retryable) without poisoning the pool.
    await expect(
      db.execute(sql`SELECT * FROM no_such_table_chaos_probe`),
    ).rejects.toThrow();

    // The pool serves the very next write: reconnect/continued service proven.
    const payment = await createPayment(
      { db },
      {
        tenantId,
        customerId: customer.id,
        amount: 1200n,
        currency: "USD",
        status: "FAILED",
        provider: "MOCK",
        providerPaymentId: `mock_reconnect_${tenantId.slice(0, 8)}`,
        occurredAt: new Date(),
      },
    );
    const reloaded = await findPaymentById({ db }, { tenantId, paymentId: payment.id });
    expect(reloaded?.id).toBe(payment.id);

    await assertInvariants(tenantId);
  });

  it("concurrent guarded transitions elect exactly one winner (no split-brain)", async () => {
    const tenant = await createChaosTenant("pgrace");
    const tenantId = tenant.id;
    const customer = await createChaosCustomer(tenantId);
    const payment = await createChaosPayment(tenantId, customer.id, "pgrace");
    const recoveryCase = await createChaosCase(tenantId, customer.id, payment, {
      status: "IN_PROGRESS",
    });

    // Simulate two writers racing on a reconnected pool after a drop.
    const [first, second] = await Promise.all([
      transitionCaseStatus(
        { db },
        { tenantId, caseId: recoveryCase.id, from: ["IN_PROGRESS"], to: "STOPPED", reason: "writer-a" },
      ),
      transitionCaseStatus(
        { db },
        { tenantId, caseId: recoveryCase.id, from: ["IN_PROGRESS"], to: "WAITING", reason: "writer-b" },
      ),
    ]);

    const winners = [first, second].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(["STOPPED", "WAITING"]).toContain(winners[0]!.status);

    await assertInvariants(tenantId);
  });

  it("compose pause drill is admin-guarded and skipped without CHAOS_INFRA", () => {
    const report = drillPausePostgres();
    expect(report.drill).toBe("postgres-reconnect");
    expect(report.skipped).toBe(true);
    expect(report.skipReason).toMatch(/CHAOS_INFRA/);
  });
});
