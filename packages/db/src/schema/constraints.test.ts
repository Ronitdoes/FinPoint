import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../client";
import {
  apiKeys,
  checkoutEvents,
  checkouts,
  customers,
  invoiceEvents,
  invoices,
  paymentAttempts,
  payments,
  subscriptions,
  tenants,
  users,
} from "./index";

describe("Database constraints and index verification", () => {
  let tenantId: string;
  let customerId: string;
  let paymentId: string;
  let checkoutId: string;
  let invoiceId: string;

  beforeAll(async () => {
    // Create a dedicated tenant for testing
    const [tenant] = await db
      .insert(tenants)
      .values({
        name: "Test Constraint Tenant",
        slug: `test-constraint-${Date.now()}`,
        status: "ACTIVE",
        settings: { timezone: "UTC", attributionWindowHours: 48 },
      })
      .returning();
    tenantId = tenant.id;

    // Create a customer
    const [customer] = await db
      .insert(customers)
      .values({
        tenantId,
        name: "John Doe",
        email: "john.doe@example.com",
        externalRef: "cust_ext_123",
        lifetimeValue: 100000n,
      })
      .returning();
    customerId = customer.id;

    // Create a payment
    const [payment] = await db
      .insert(payments)
      .values({
        tenantId,
        customerId,
        amount: 5000n,
        currency: "USD",
        status: "CREATED",
        provider: "STRIPE",
        providerPaymentId: "pi_test_123",
        occurredAt: new Date(),
      })
      .returning();
    paymentId = payment.id;

    // Create a checkout
    const [checkout] = await db
      .insert(checkouts)
      .values({
        tenantId,
        customerId,
        cartValue: 12000n,
        currency: "USD",
        items: [{ sku: "SKU-1", name: "Item 1", quantity: 1, unitAmountMinor: 12000 }],
        status: "STARTED",
        sourceRef: "chk_test_123",
        startedAt: new Date(),
        lastActivityAt: new Date(),
      })
      .returning();
    checkoutId = checkout.id;

    // Create an invoice
    const [invoice] = await db
      .insert(invoices)
      .values({
        tenantId,
        customerId,
        number: "INV-2026-0001",
        amount: 25000n,
        currency: "USD",
        status: "DRAFT",
        dueAt: new Date(Date.now() + 86400000 * 7),
      })
      .returning();
    invoiceId = invoice.id;
  }, 30000);

  afterAll(async () => {
    // Clean up created test data
    if (tenantId) {
      await db.delete(checkoutEvents).where(sql`checkout_id = ${checkoutId}`);
      await db.delete(checkouts).where(sql`id = ${checkoutId}`);
      await db.delete(invoiceEvents).where(sql`invoice_id = ${invoiceId}`);
      await db.delete(invoices).where(sql`id = ${invoiceId}`);
      await db.delete(paymentAttempts).where(sql`payment_id = ${paymentId}`);
      await db.delete(payments).where(sql`id = ${paymentId}`);
      await db.delete(subscriptions).where(sql`tenant_id = ${tenantId}`);
      await db.delete(apiKeys).where(sql`tenant_id = ${tenantId}`);
      await db.delete(users).where(sql`tenant_id = ${tenantId}`);
      await db.delete(customers).where(sql`id = ${customerId}`);
      await db.delete(tenants).where(sql`id = ${tenantId}`);
    }
  }, 30000);

  it("rejects duplicate (tenant_id, provider, provider_payment_id) on payments", async () => {
    await expect(
      Promise.resolve(
        db.insert(payments).values({
          tenantId,
          customerId,
          amount: 3000n,
          currency: "USD",
          status: "CREATED",
          provider: "STRIPE",
          providerPaymentId: "pi_test_123", // Duplicate
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects non-positive payment amounts via CHECK constraint (amount > 0)", async () => {
    await expect(
      Promise.resolve(
        db.insert(payments).values({
          tenantId,
          customerId,
          amount: 0n, // Zero amount
          currency: "USD",
          status: "CREATED",
          provider: "STRIPE",
          providerPaymentId: "pi_test_zero",
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toThrow();

    await expect(
      Promise.resolve(
        db.insert(payments).values({
          tenantId,
          customerId,
          amount: -500n, // Negative amount
          currency: "USD",
          status: "CREATED",
          provider: "STRIPE",
          providerPaymentId: "pi_test_neg",
          occurredAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects missing tenant foreign key on users", async () => {
    const nonExistentTenantId = "00000000-0000-0000-0000-000000000000";
    await expect(
      Promise.resolve(
        db.insert(users).values({
          tenantId: nonExistentTenantId,
          email: "orphan@example.com",
          name: "Orphan User",
          role: "VIEWER",
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate (tenant_id, email) on users", async () => {
    const [user] = await db
      .insert(users)
      .values({
        tenantId,
        email: "alice@example.com",
        name: "Alice",
        role: "ADMIN",
      })
      .returning();

    expect(user.id).toBeDefined();

    await expect(
      Promise.resolve(
        db.insert(users).values({
          tenantId,
          email: "alice@example.com", // Duplicate email within same tenant
          name: "Alice Clone",
          role: "VIEWER",
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate (payment_id, attempt_number) on payment_attempts", async () => {
    const idempotencyKey1 = `${tenantId}:case-1:RETRY_PAYMENT:1`;
    const [attempt] = await db
      .insert(paymentAttempts)
      .values({
        tenantId,
        paymentId,
        attemptNumber: 1,
        initiatedBy: "RECOVERY_WORKFLOW",
        idempotencyKey: idempotencyKey1,
        status: "REQUESTED",
        requestedAt: new Date(),
      })
      .returning();

    expect(attempt.id).toBeDefined();

    const idempotencyKey2 = `${tenantId}:case-1:RETRY_PAYMENT:1_dup`;
    await expect(
      Promise.resolve(
        db.insert(paymentAttempts).values({
          tenantId,
          paymentId,
          attemptNumber: 1, // Duplicate attempt_number for same payment
          initiatedBy: "MANUAL",
          idempotencyKey: idempotencyKey2,
          status: "REQUESTED",
          requestedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate idempotency_key on payment_attempts", async () => {
    const idempotencyKey = `${tenantId}:case-2:RETRY_PAYMENT:2`;
    await db.insert(paymentAttempts).values({
      tenantId,
      paymentId,
      attemptNumber: 2,
      initiatedBy: "RECOVERY_WORKFLOW",
      idempotencyKey,
      status: "REQUESTED",
      requestedAt: new Date(),
    });

    await expect(
      Promise.resolve(
        db.insert(paymentAttempts).values({
          tenantId,
          paymentId,
          attemptNumber: 3,
          initiatedBy: "RECOVERY_WORKFLOW",
          idempotencyKey, // Duplicate idempotency key
          status: "REQUESTED",
          requestedAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects duplicate (tenant_id, number) on invoices", async () => {
    await expect(
      Promise.resolve(
        db.insert(invoices).values({
          tenantId,
          customerId,
          number: "INV-2026-0001", // Duplicate number within same tenant
          amount: 10000n,
          currency: "USD",
          status: "DRAFT",
          dueAt: new Date(),
        }),
      ),
    ).rejects.toThrow();
  });

  it("cascades deletion from checkout to checkout_events", async () => {
    const [tempCheckout] = await db
      .insert(checkouts)
      .values({
        tenantId,
        customerId,
        cartValue: 5000n,
        currency: "USD",
        items: [],
        status: "STARTED",
        sourceRef: "chk_cascade_test",
        startedAt: new Date(),
        lastActivityAt: new Date(),
      })
      .returning();

    await db.insert(checkoutEvents).values({
      checkoutId: tempCheckout.id,
      type: "checkout.started",
      payload: { cart_id: "chk_cascade_test" },
      occurredAt: new Date(),
    });

    // Delete parent checkout
    await db.delete(checkouts).where(sql`id = ${tempCheckout.id}`);

    // Verify child events were cascaded
    const events = await db
      .select()
      .from(checkoutEvents)
      .where(sql`checkout_id = ${tempCheckout.id}`);
    expect(events.length).toBe(0);
  });

  it("cascades deletion from invoice to invoice_events", async () => {
    const [tempInvoice] = await db
      .insert(invoices)
      .values({
        tenantId,
        customerId,
        number: "INV-TEMP-CASCADE",
        amount: 8000n,
        currency: "USD",
        status: "DRAFT",
        dueAt: new Date(),
      })
      .returning();

    await db.insert(invoiceEvents).values({
      invoiceId: tempInvoice.id,
      type: "invoice.created",
      payload: { number: "INV-TEMP-CASCADE" },
      occurredAt: new Date(),
    });

    // Delete parent invoice
    await db.delete(invoices).where(sql`id = ${tempInvoice.id}`);

    // Verify child events were cascaded
    const events = await db
      .select()
      .from(invoiceEvents)
      .where(sql`invoice_id = ${tempInvoice.id}`);
    expect(events.length).toBe(0);
  });

  it("verifies customer soft delete via deleted_at", async () => {
    const now = new Date();
    const [updatedCustomer] = await db
      .update(customers)
      .set({ deletedAt: now })
      .where(sql`id = ${customerId}`)
      .returning();

    expect(updatedCustomer.deletedAt).toBeInstanceOf(Date);
  });

  it("confirms presence of all spec-mandated indexes in pg_indexes", async () => {
    const result = await db.execute<{ indexname: string; tablename: string }>(
      sql`SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public';`,
    );

    const indexNames = result.map((r) => r.indexname);

    // Spec 01 §5 & step 04 mandated indexes
    expect(indexNames).toContain("payments_customer_created_at_idx");
    expect(indexNames).toContain("payments_status_created_at_idx");
    expect(indexNames).toContain("payments_tenant_occurred_at_idx");
    expect(indexNames).toContain("payments_tenant_provider_payment_id_unique");
    expect(indexNames).toContain("invoices_status_due_at_idx");
    expect(indexNames).toContain("invoices_tenant_number_unique");
    expect(indexNames).toContain("checkouts_status_last_activity_idx");
    expect(indexNames).toContain("checkouts_tenant_source_ref_unique");
    expect(indexNames).toContain("customers_tenant_external_ref_unique");
    expect(indexNames).toContain("customers_tenant_email_idx");
    expect(indexNames).toContain("customers_tenant_phone_idx");
    expect(indexNames).toContain("subscriptions_customer_status_idx");
    expect(indexNames).toContain("subscriptions_tenant_provider_sub_id_unique");
    expect(indexNames).toContain("payment_attempts_payment_attempt_number_unique");
    expect(indexNames).toContain("payment_attempts_idempotency_key_unique");
    expect(indexNames).toContain("users_tenant_email_unique");
    expect(indexNames).toContain("checkout_events_checkout_occurred_at_idx");
    expect(indexNames).toContain("invoice_events_invoice_occurred_at_idx");
  });
});
