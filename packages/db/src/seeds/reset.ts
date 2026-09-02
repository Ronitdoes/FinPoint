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

  // 3. Delete tenant-scoped data in reverse foreign-key dependency order
  await db.execute(sql`DELETE FROM recovery_cost_entries WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM recovery_outcomes WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM human_tasks WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM promises_to_pay WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM recovery_actions WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM workflow_events WHERE workflow_row_id IN (SELECT id FROM workflows WHERE tenant_id = ${tenantId})`);
  await db.execute(sql`DELETE FROM workflows WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM recovery_cases WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM revenue_risks WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM checkout_events WHERE checkout_id IN (SELECT id FROM checkouts WHERE tenant_id = ${tenantId})`);
  await db.execute(sql`DELETE FROM checkouts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM payment_attempts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM payments WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM subscriptions WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM invoices WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM events WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM customers WHERE tenant_id = ${tenantId}`);

  return {
    tenantId,
    deletedCounts: {
      resetSuccess: 1,
    },
  };
}
