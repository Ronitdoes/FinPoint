import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, end } from "../client";
import {
  tenants,
  customers,
  payments,
  paymentAttempts,
  checkouts,
  checkoutEvents,
  invoices,
  revenueRisks,
  recoveryCases,
  recoveryActions,
  workflows,
  workflowEvents,
  recoveryOutcomes,
  recoveryCostEntries,
} from "../schema";
import {
  DeterministicPrng,
  DEFAULT_SEED,
  REFERENCE_DATE,
  FIRST_NAMES,
  LAST_NAMES,
  DOMAINS,
  DECLINE_CODES,
  CARD_BRANDS,
  CHANNELS,
  RISK_BANDS,
} from "./factories";
import { seedScenarios } from "./scenarios";
import { resetDemoTenantData } from "./reset";

export { resetDemoTenantData } from "./reset";
export { seedScenarios } from "./scenarios";
export { DeterministicPrng } from "./factories";

export interface SeedVolumeCounts {
  customers: number;
  payments: number;
  failedPayments: number;
  activeCheckouts: number;
  abandonedCheckouts: number;
  overdueInvoices: number;
  recoveryCases: number;
  recoveredOutcomes: number;
}

export interface SeedResult {
  tenantId: string;
  tenantSlug: string;
  counts: SeedVolumeCounts;
  contentHash: string;
}

/**
 * Main volume demo seed script (Spec 01 §24, Spec 03 §3, Step 29).
 */
export async function seedDemoData(options: {
  tenantSlug?: string;
  reset?: boolean;
  seed?: number;
  targetDb?: any;
} = {}): Promise<SeedResult> {
  const targetDb = options.targetDb || db;
  const tenantSlug = (options.tenantSlug || process.env.BOOTSTRAP_TENANT_SLUG || "demo-tenant").toLowerCase().trim();
  const prng = new DeterministicPrng(options.seed ?? DEFAULT_SEED);

  console.log(`\n🌱 Initiating Demo Seed on tenant: '${tenantSlug}'...`);

  // 1. Check or create demo tenant
  let [tenant] = await targetDb
    .select()
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .limit(1);

  if (!tenant) {
    console.log(`🏢 Creating Demo Tenant '${tenantSlug}'...`);
    [tenant] = await targetDb
      .insert(tenants)
      .values({
        name: "Demo Organization",
        slug: tenantSlug,
        status: "ACTIVE",
        settings: {
          currency: "INR",
          timezone: "Asia/Kolkata",
          defaultProvider: "STRIPE",
        },
      })
      .returning();
  }

  const tenantId = tenant.id;

  // 2. Safe reset if requested (Spec 29 §Requirements 5)
  if (options.reset) {
    console.log(`🧹 Executing safe tenant-scoped reset on '${tenantSlug}'...`);
    await resetDemoTenantData(targetDb, tenantSlug);
    console.log(`✅ Safe reset completed.`);
  }

  const hashCollector: string[] = [];

  // 3. Seed 1,000 Customers (Spec 01 §24)
  console.log("👥 Generating 1,000 customers...");
  const customerRows: any[] = [];
  for (let i = 1; i <= 1000; i++) {
    const firstName = prng.choice(FIRST_NAMES);
    const lastName = prng.choice(LAST_NAMES);
    const domain = prng.choice(DOMAINS);
    const externalRef = `CUS-GEN-${String(i).padStart(4, "0")}`;
    const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${i}@${domain}`;
    const phone = `+91${prng.nextInt(9000000000, 9999999999)}`;
    const ltv = prng.logNormalAmount(350000, 0.9);
    const createdAt = prng.dateSpread(10, 90);

    customerRows.push({
      tenantId,
      externalRef,
      name: `${firstName} ${lastName}`,
      email,
      phone,
      status: "ACTIVE",
      lifetimeValue: ltv,
      metadata: { seeded: true, index: i },
      createdAt,
      updatedAt: createdAt,
    });
  }

  // Batch insert customers in chunks of 250
  const insertedCustomers: any[] = [];
  for (let i = 0; i < customerRows.length; i += 250) {
    const chunk = customerRows.slice(i, i + 250);
    const batch = await targetDb.insert(customers).values(chunk).returning();
    insertedCustomers.push(...batch);
  }

  for (const c of insertedCustomers) {
    hashCollector.push(`cust:${c.externalRef}:${c.lifetimeValue}`);
  }

  // 4. Seed Pristine Scenarios A, B, C (Spec 03 §3)
  console.log("🎯 Seeding pristine pre-trigger Scenarios A, B, and C...");
  const scenarioResults = await seedScenarios(targetDb, tenantId, prng);

  // 5. Seed 2,500 Payments (2,200 Succeeded + 300 Failed) (Spec 01 §24)
  console.log("💳 Generating 2,500 payments (2,200 succeeded, 300 failed)...");
  const paymentRows: any[] = [];
  const attemptRows: any[] = [];

  // A. 2,200 Succeeded Payments
  for (let i = 1; i <= 2200; i++) {
    const cust = insertedCustomers[i % insertedCustomers.length]!;
    const amount = prng.logNormalAmount(249900, 0.7); // Median ~₹2,499
    const occurredAt = prng.dateSpread(1, 90);
    const provider = i % 3 === 0 ? "RAZORPAY" : "STRIPE";
    const providerPaymentId =
      provider === "STRIPE"
        ? `pi_seed_succ_${String(i).padStart(5, "0")}`
        : `pay_seed_succ_${String(i).padStart(5, "0")}`;

    paymentRows.push({
      tenantId,
      customerId: cust.id,
      amount,
      currency: "INR",
      status: "SUCCEEDED" as const,
      provider,
      providerPaymentId,
      methodMetadata: {
        brand: prng.choice(CARD_BRANDS),
        last4: String(prng.nextInt(1000, 9999)),
      },
      occurredAt,
      paidAt: occurredAt,
      metadata: { seeded: true, type: "success" },
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
  }

  // B. 300 Failed Payments with realistic decline-code mix
  for (let i = 1; i <= 300; i++) {
    const cust = insertedCustomers[(i + 500) % insertedCustomers.length]!;
    const amount = prng.logNormalAmount(399900, 0.8); // Median ~₹3,999
    const occurredAt = prng.dateSpread(1, 90);
    const provider = i % 2 === 0 ? "STRIPE" : "RAZORPAY";
    const failureCode = prng.choice(DECLINE_CODES);
    const providerPaymentId =
      provider === "STRIPE"
        ? `pi_seed_fail_${String(i).padStart(4, "0")}`
        : `pay_seed_fail_${String(i).padStart(4, "0")}`;

    paymentRows.push({
      tenantId,
      customerId: cust.id,
      amount,
      currency: "INR",
      status: "FAILED" as const,
      provider,
      providerPaymentId,
      failureCode,
      failureMessage: `Payment declined: ${failureCode.replace(/_/g, " ")}`,
      methodMetadata: {
        brand: prng.choice(CARD_BRANDS),
        last4: String(prng.nextInt(1000, 9999)),
      },
      occurredAt,
      metadata: { seeded: true, type: "failure" },
      createdAt: occurredAt,
      updatedAt: occurredAt,
    });
  }

  // Batch insert payments in chunks of 250
  const insertedPayments: any[] = [];
  for (let i = 0; i < paymentRows.length; i += 250) {
    const chunk = paymentRows.slice(i, i + 250);
    const batch = await targetDb.insert(payments).values(chunk).returning();
    insertedPayments.push(...batch);
  }

  for (const p of insertedPayments) {
    hashCollector.push(`pay:${p.providerPaymentId}:${p.amount}:${p.status}`);
  }

  // 6. Seed Checkouts (250 Active + 150 Abandoned = 400 Checkouts) (Spec 01 §24)
  console.log("🛒 Generating 400 checkouts (250 active, 150 abandoned)...");
  const checkoutRows: any[] = [];

  // A. 250 Active Checkouts (started recently, active status)
  for (let i = 1; i <= 250; i++) {
    const cust = insertedCustomers[(i * 3) % insertedCustomers.length]!;
    const cartValue = prng.logNormalAmount(199900, 0.6);
    const startedAt = prng.dateSpread(0.01, 1); // Started within last 24h
    const sourceRef = `chk_active_${String(i).padStart(4, "0")}`;

    checkoutRows.push({
      tenantId,
      customerId: cust.id,
      cartValue,
      currency: "INR",
      sourceRef,
      status: "STARTED" as const,
      startedAt,
      lastActivityAt: startedAt,
      items: [
        {
          sku: `SKU-${prng.nextInt(100, 999)}`,
          name: "Standard Subscription Tier",
          quantity: 1,
          unitPriceMinor: Number(cartValue),
        },
      ],
      metadata: { seeded: true, type: "active" },
    });
  }

  // B. 150 Abandoned Checkouts
  for (let i = 1; i <= 150; i++) {
    const cust = insertedCustomers[(i * 5) % insertedCustomers.length]!;
    const cartValue = prng.logNormalAmount(499900, 0.7);
    const startedAt = prng.dateSpread(1, 60);
    const abandonedAt = new Date(startedAt.getTime() + 1800 * 1000); // 30m later
    const sourceRef = `chk_abandoned_${String(i).padStart(4, "0")}`;

    checkoutRows.push({
      tenantId,
      customerId: cust.id,
      cartValue,
      currency: "INR",
      sourceRef,
      status: "ABANDONED" as const,
      startedAt,
      lastActivityAt: startedAt,
      abandonedAt,
      items: [
        {
          sku: `SKU-PRO-${prng.nextInt(100, 999)}`,
          name: "Enterprise Add-on Module",
          quantity: 1,
          unitPriceMinor: Number(cartValue),
        },
      ],
      metadata: { seeded: true, type: "abandoned" },
    });
  }

  // Batch insert checkouts in chunks of 200
  const insertedCheckouts: any[] = [];
  for (let i = 0; i < checkoutRows.length; i += 200) {
    const chunk = checkoutRows.slice(i, i + 200);
    const batch = await targetDb.insert(checkouts).values(chunk).returning();
    insertedCheckouts.push(...batch);
  }

  for (const chk of insertedCheckouts) {
    hashCollector.push(`chk:${chk.sourceRef}:${chk.cartValue}:${chk.status}`);
  }

  // 7. Seed 180 Overdue Invoices (Spec 01 §24)
  console.log("📄 Generating 180 overdue invoices...");
  const invoiceRows: any[] = [];
  for (let i = 1; i <= 180; i++) {
    const cust = insertedCustomers[(i * 7) % insertedCustomers.length]!;
    const amount = prng.logNormalAmount(7500000, 0.9); // Median ~₹75,000
    const daysOverdue = prng.nextInt(1, 60);
    const now = REFERENCE_DATE;
    const dueAt = new Date(now.getTime() - daysOverdue * 86400 * 1000);
    const issuedAt = new Date(dueAt.getTime() - 30 * 86400 * 1000); // 30 day terms
    const number = `INV-2026-${String(i).padStart(4, "0")}`;

    invoiceRows.push({
      tenantId,
      customerId: cust.id,
      number,
      amount,
      amountPaid: 0n,
      currency: "INR",
      status: "OVERDUE" as const,
      issuedAt,
      dueAt,
      providerInvoiceId: `in_seed_overdue_${String(i).padStart(4, "0")}`,
      metadata: { seeded: true, daysOverdue },
    });
  }

  const insertedInvoices = await targetDb.insert(invoices).values(invoiceRows).returning();
  for (const inv of insertedInvoices) {
    hashCollector.push(`inv:${inv.number}:${inv.amount}:${inv.status}`);
  }

  // 8. Seed 100 Recovery Cases across risk bands and states (Spec 01 §24, Spec 29 §Requirements 4)
  console.log("⚖️ Generating 100 recovery cases with outcomes and cost entries...");
  const failedPaymentsList = insertedPayments.filter((p: any) => p.status === "FAILED");
  const caseRows: any[] = [];
  const outcomeRows: any[] = [];
  const costEntryRows: any[] = [];

  // Distribution:
  // - RECOVERED: 45 cases (with authoritative recovery_outcomes and costs)
  // - STOPPED: 20 cases
  // - ESCALATED: 15 cases
  // - IN_PROGRESS: 20 cases
  // Target open risk ~₹12.8L (Scene 1 requirement)

  for (let i = 1; i <= 100; i++) {
    const payment = failedPaymentsList[(i - 1) % failedPaymentsList.length]!;
    const cust = insertedCustomers.find((c: any) => c.id === payment.customerId)!;

    let status: "RECOVERED" | "STOPPED" | "ESCALATED" | "IN_PROGRESS";
    let band: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

    if (i <= 45) {
      status = "RECOVERED";
      band = i <= 15 ? "LOW" : i <= 35 ? "MEDIUM" : "HIGH";
    } else if (i <= 65) {
      status = "STOPPED";
      band = i <= 55 ? "MEDIUM" : "HIGH";
    } else if (i <= 80) {
      status = "ESCALATED";
      band = i <= 75 ? "HIGH" : "CRITICAL";
    } else {
      status = "IN_PROGRESS";
      band = i <= 88 ? "MEDIUM" : i <= 96 ? "HIGH" : "CRITICAL";
    }

    const score =
      band === "LOW"
        ? prng.nextInt(20, 39)
        : band === "MEDIUM"
          ? prng.nextInt(40, 69)
          : band === "HIGH"
            ? prng.nextInt(70, 89)
            : prng.nextInt(90, 99);

    const createdAt = prng.dateSpread(2, 60);

    // Active cases adjust amount to sum up to ~₹12.8L at risk (Spec 01 §27 Scene 1)
    let amountAtRisk = payment.amount;
    if (status === "IN_PROGRESS") {
      amountAtRisk = 6400000n; // 20 in-progress cases * ₹64,000 = ₹12.8 Lakhs
    }

    caseRows.push({
      tenantId,
      customerId: cust.id,
      caseNumber: i,
      riskType: "PAYMENT_FAILURE" as const,
      sourceEntityType: "PAYMENT",
      sourceEntityId: payment.id,
      amountAtRisk,
      currency: "INR",
      riskScore: score,
      band,
      status,
      tags: [`band-${band.toLowerCase()}`, `status-${status.toLowerCase()}`],
      metadata: { seeded: true, caseIndex: i },
      createdAt,
      updatedAt: createdAt,
    });
  }

  const insertedCases = await targetDb.insert(recoveryCases).values(caseRows).returning();

  // Create outcomes & cost entries for the 45 RECOVERED cases
  for (let i = 0; i < 45; i++) {
    const rc = insertedCases[i]!;
    const recoveredAt = new Date(rc.createdAt.getTime() + prng.nextInt(3600, 86400 * 2) * 1000);
    const baseline = rc.amountAtRisk;
    const feeCost = BigInt(Math.round(Number(baseline) * 0.02)); // 2% processing fee
    const msgCost = 2000n; // ₹20 messaging cost
    const totalCost = feeCost + msgCost;

    outcomeRows.push({
      tenantId,
      caseId: rc.id,
      paymentId: rc.sourceEntityId,
      baselineAmount: baseline,
      recoveredAmount: baseline,
      recoveryCost: totalCost,
      attributionMethod: i % 2 === 0 ? "PAYMENT_RETRY" : "PAYMENT_LINK",
      attributionWindowHours: 72,
      recoveredAt,
      metadata: { seeded: true },
    });

    costEntryRows.push(
      {
        tenantId,
        caseId: rc.id,
        category: "PAYMENT_PROCESSING" as const,
        amount: feeCost,
        currency: "INR",
        incurredAt: recoveredAt,
        metadata: { provider: "STRIPE", feeType: "interchange" },
      },
      {
        tenantId,
        caseId: rc.id,
        category: "MESSAGING" as const,
        amount: msgCost,
        currency: "INR",
        incurredAt: recoveredAt,
        metadata: { channel: "WHATSAPP", template: "payment_retry_notice" },
      },
    );
  }

  await targetDb.insert(recoveryOutcomes).values(outcomeRows);
  await targetDb.insert(recoveryCostEntries).values(costEntryRows);

  for (const c of insertedCases) {
    hashCollector.push(`case:${c.caseNumber}:${c.band}:${c.status}:${c.amountAtRisk}`);
  }

  // 9. Compute Deterministic Seed Content Hash
  const hash = createHash("sha256").update(hashCollector.join("\n")).digest("hex");

  console.log("\n=======================================================");
  console.log("🎉 DEMO SEED COMPLETED SUCCESSFULLY!");
  console.log(`🏢 Tenant:            ${tenantSlug} (${tenantId})`);
  console.log(`👥 Customers:         1,000`);
  console.log(`💳 Payments:          2,500 (2,200 succeeded, 300 failed)`);
  console.log(`🛒 Checkouts:         400 (250 active, 150 abandoned)`);
  console.log(`📄 Overdue Invoices:  180`);
  console.log(`⚖️ Recovery Cases:    100 (45 recovered, 20 stopped, 15 escalated, 20 in-progress)`);
  console.log(`📊 Outbound Outcomes: 45 authoritative outcomes + 90 cost entries`);
  console.log(`🎯 Scenario Fixtures: CUS-001 (A), CUS-002 (B), CUS-003 (C) + A-variant`);
  console.log(`🔒 Determinism Hash:  ${hash}`);
  console.log("=======================================================\n");

  return {
    tenantId,
    tenantSlug,
    counts: {
      customers: 1000,
      payments: 2500,
      failedPayments: 300,
      activeCheckouts: 250,
      abandonedCheckouts: 150,
      overdueInvoices: 180,
      recoveryCases: 100,
      recoveredOutcomes: 45,
    },
    contentHash: hash,
  };
}

// CLI Execution Support (`bun run src/seeds/demo.ts` or `bun run db:seed`)
if (
  (import.meta as { main?: boolean }).main ||
  process.argv[1]?.endsWith("demo.ts") ||
  process.argv.includes("--seed")
) {
  const resetRequested = process.argv.includes("--reset");
  seedDemoData({ reset: resetRequested })
    .then(async () => {
      await end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error("❌ Seed execution error:", err);
      await end();
      process.exit(1);
    });
}
