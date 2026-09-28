import { eq, sql } from "drizzle-orm";
import { tenants } from "../schema/tenants";

const DEMO_SLUG_ALLOWLIST = ["demo-tenant", "demo", "test-tenant", "sandbox"];

/**
 * Safely resets tenant-scoped operational demo data (Spec 29 §Requirements 5).
 * NEVER touches users, sessions, or real deployment tenants — strictly guarded
 * by tenant slug inspection.
 */
export async function resetDemoTenantData(
  db: any,
  tenantSlug: string = "demo-tenant",
): Promise<{ tenantId: string; deletedCounts: Record<string, number> }> {
  const normalizedSlug = tenantSlug.toLowerCase().trim();

  // 1. Strict slug guard: prevent running on production or non-demo tenants
  const isAllowedSlug =
    DEMO_SLUG_ALLOWLIST.includes(normalizedSlug) ||
    normalizedSlug.startsWith("demo-") ||
    normalizedSlug.startsWith("test-");

  if (!isAllowedSlug) {
    throw new Error(
      `Safety guard violation: '${tenantSlug}' is not a permitted demo tenant slug. Reset is strictly disabled for non-demo deployments.`,
    );
  }

  // 2. Resolve tenant
  const [tenant] = await db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, normalizedSlug))
    .limit(1);

  if (!tenant) {
    return {
      tenantId: "",
      deletedCounts: {},
    };
  }

  const tenantId = tenant.id;

  // 3. Delete tenant-scoped data in reverse foreign-key dependency order.
  // Runs in a single transaction so a cold demo reset is atomic, with the
  // s-35 audit-reset hatch (migration 0010) enabled transaction-locally:
  // append-only triggers stay default-deny everywhere except inside this
  // slug-guarded block. Tables with ON DELETE CASCADE (case_events,
  // message_delivery_events, invoice_events, checkout_events,
  // workflow_events) are deleted explicitly first so the reset never depends
  // on cascade-into-immutable-table behavior.
  await db.transaction(async (tx: any) => {
    const run = (q: unknown) => tx.execute(q as never);
    await run(sql.raw("SET LOCAL app.allow_audit_delete = 'on'"));

    // Leaves of the recovery-case fan-out (RESTRICT + SET NULL + CASCADE).
    await run(sql`DELETE FROM message_delivery_events WHERE message_id IN (SELECT id FROM messages WHERE tenant_id = ${tenantId})`);
    await run(sql`DELETE FROM messages WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM customer_responses WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM case_events WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM audit_archive WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM policy_evaluations WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM recovery_cost_entries WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM recovery_outcomes WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM human_tasks WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM promises_to_pay WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM recovery_actions WHERE tenant_id = ${tenantId}`);
    // ai_decisions.case_id is ON DELETE RESTRICT (s-35 friction log).
    await run(sql`DELETE FROM ai_decisions WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM workflow_events WHERE workflow_row_id IN (SELECT id FROM workflows WHERE tenant_id = ${tenantId})`);
    await run(sql`DELETE FROM workflows WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM recovery_cases WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM revenue_risks WHERE tenant_id = ${tenantId}`);

    // Financial core leaves before parents.
    await run(sql`DELETE FROM invoice_events WHERE invoice_id IN (SELECT id FROM invoices WHERE tenant_id = ${tenantId})`);
    await run(sql`DELETE FROM checkout_events WHERE checkout_id IN (SELECT id FROM checkouts WHERE tenant_id = ${tenantId})`);
    await run(sql`DELETE FROM checkouts WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM payment_attempts WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM payments WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM subscriptions WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM invoices WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM events WHERE tenant_id = ${tenantId}`);
    await run(sql`DELETE FROM customers WHERE tenant_id = ${tenantId}`);
    // Deliberately untouched: tenants, users, user_sessions, api_keys,
    // policy_rules + policy_versions (platform config re-seeded by seed flow).
  });

  return {
    tenantId,
    deletedCounts: {
      resetSuccess: 1,
    },
  };
}
