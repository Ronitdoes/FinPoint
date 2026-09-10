import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../client";
import {
  aiDecisions,
  auditLogs,
  caseEvents,
  customers,
  customerResponses,
  messages,
  policyEvaluations,
  recoveryCases,
  revenueRisks,
  tenants,
} from "../schema/index";
import { resetDemoTenantData } from "./reset";

/**
 * s-35 release-gate regression: tenant-scoped demo reset must succeed AFTER
 * real recovery activity ran (AI decisions + append-only timeline rows exist).
 *
 * Friction log: `db:seed --reset` failed on a lived-in demo tenant with
 *   1. `ai_decisions.case_id` RESTRICT violation (decisions were never deleted), then
 *   2. `prevent_audit_modification()` trigger abort on case_events cascade.
 * Fixed by migration 0010 (transaction-local `app.allow_audit_delete` hatch,
 * default-deny preserved) + reverse-FK delete ordering in reset.ts.
 */
describe("demo tenant reset after live activity (s-35)", () => {
  const slug = `test-reset-${randomUUID().slice(0, 8)}`;
  let tenantId: string;
  let caseId: string;

  async function seedActivity() {
    const [tenant] = await db
      .insert(tenants)
      .values({ name: "Reset Regression Tenant", slug, status: "ACTIVE" })
      .returning();
    tenantId = tenant.id;

    const [customer] = await db
      .insert(customers)
      .values({ tenantId, name: "Reset Probe", externalRef: `reset-${slug}` })
      .returning();

    const [risk] = await db
      .insert(revenueRisks)
      .values({
        tenantId,
        customerId: customer.id,
        riskType: "PAYMENT_FAILURE",
        subjectType: "payment",
        subjectId: randomUUID(),
        score: 86,
        band: "HIGH",
        factors: { reason: "s-35 regression probe" },
        status: "OPEN",
        computedAt: new Date(),
      })
      .returning();

    const [recoveryCase] = await db
      .insert(recoveryCases)
      .values({
        tenantId,
        caseNumber: 1,
        customerId: customer.id,
        riskId: risk.id,
        riskType: "PAYMENT_FAILURE",
        sourceEntityType: "payment",
        sourceEntityId: randomUUID(),
        amountAtRisk: 1299900n,
        currency: "INR",
        riskScore: 86,
        status: "IN_PROGRESS",
      })
      .returning();
    caseId = recoveryCase.id;

    // The exact rows that broke reset: a RESTRICT-guarded AI decision and
    // trigger-protected append-only rows.
    const [decision] = await db
      .insert(aiDecisions)
      .values({
        tenantId,
        caseId,
        model: "regression-probe",
        promptVersion: "payment_failure@1",
        inputSnapshot: {},
        recommendedActions: [],
        status: "COMPLETED",
      })
      .returning();

    await db.insert(caseEvents).values({
      tenantId,
      caseId,
      eventType: "RISK_EVALUATED",
      actorType: "SYSTEM",
      payload: {},
    });
    await db.insert(auditLogs).values({
      tenantId,
      caseId,
      actorType: "SYSTEM",
      event: "RISK_EVALUATED",
      metadata: {},
    });
    await db.insert(policyEvaluations).values({
      tenantId,
      caseId,
      decisionId: decision.id,
      ruleVersions: [],
      result: "ALLOWED",
      rejections: [],
      effectiveActions: [],
      latencyMs: 1,
    });
    await db.insert(messages).values({
      tenantId,
      caseId,
      customerId: customer.id,
      channel: "WHATSAPP",
      templateId: "payment_reminder",
      variables: {},
      toAddress: "+910000000000",
      provider: "MOCK",
      idempotencyKey: `test:${slug}:WHATSAPP:payment_reminder:1`,
    });
    await db.insert(customerResponses).values({
      tenantId,
      caseId,
      customerId: customer.id,
      type: "REPLY",
    });
  }

  afterAll(async () => {
    // Best-effort cleanup of the probe tenant itself (no FK parents remain).
    if (tenantId) {
      await db.execute(
        sql`DELETE FROM customers WHERE tenant_id = ${tenantId}`,
      );
      await db.execute(
        sql`DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
  });

  it("resets cleanly after decisions + append-only rows exist", async () => {
    await seedActivity();

    const result = await resetDemoTenantData(db, slug);

    expect(result.tenantId).toBe(tenantId);
    expect(
      await db
        .select({ id: recoveryCases.id })
        .from(recoveryCases)
        .where(eq(recoveryCases.tenantId, tenantId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: aiDecisions.id })
        .from(aiDecisions)
        .where(eq(aiDecisions.tenantId, tenantId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: caseEvents.id })
        .from(caseEvents)
        .where(eq(caseEvents.tenantId, tenantId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(eq(auditLogs.tenantId, tenantId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.tenantId, tenantId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: customerResponses.id })
        .from(customerResponses)
        .where(eq(customerResponses.tenantId, tenantId)),
    ).toHaveLength(0);
    expect(
      await db
        .select({ id: policyEvaluations.id })
        .from(policyEvaluations)
        .where(eq(policyEvaluations.tenantId, tenantId)),
    ).toHaveLength(0);

    // Tenant + customer shells survive for re-seed.
    expect(
      await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.id, tenantId)),
    ).toHaveLength(1);
  });

  it("keeps append-only immutability default-deny outside reset", async () => {
    const probeSlug = `test-reset-deny-${randomUUID().slice(0, 8)}`;
    const [tenant] = await db
      .insert(tenants)
      .values({ name: "Deny Probe", slug: probeSlug, status: "ACTIVE" })
      .returning();
    const [row] = await db
      .insert(auditLogs)
      .values({
        tenantId: tenant.id,
        actorType: "SYSTEM",
        event: "PROBE",
        metadata: {},
      })
      .returning();

    await expect(
      db.execute(sql`DELETE FROM audit_logs WHERE id = ${row.id}`),
    ).rejects.toThrow(/append-only and immutable/);

    // Cleanup via the guarded path (proves the hatch is scoped to reset).
    await resetDemoTenantData(db, probeSlug);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${tenant.id}`);
  });
});
