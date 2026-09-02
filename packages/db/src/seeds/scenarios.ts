import {
  customers,
  payments,
  checkouts,
  invoices,
  recoveryCases,
  recoveryOutcomes,
  recoveryCostEntries,
  recoveryActions,
  workflows,
} from "../schema";
import type { Database } from "../client";
import { DeterministicPrng, REFERENCE_DATE } from "./factories";

export interface SeedScenariosResult {
  scenarioACustomerId: string;
  scenarioBCustomerId: string;
  scenarioCCustomerId: string;
  completedCaseId: string;
}

/**
 * Seeds pristine pre-trigger fixtures for Scenarios A, B, and C per Spec 03 §3,
 * plus one completed A-variant case for dashboard richness (Spec 29 §Requirements 4).
 */
export async function seedScenarios(
  db: any,
  tenantId: string,
  prng: DeterministicPrng = new DeterministicPrng(0x5ca1e),
): Promise<SeedScenariosResult> {
  const now = new Date();

  // ===========================================================================
  // SCENARIO A: CUS-001 (High-intent failed payment)
  // 17 successes, 1 failure in history. Ready for ₹12,999 failure trigger.
  // ===========================================================================
  const [customerA] = await db
    .insert(customers)
    .values({
      tenantId,
      externalRef: "CUS-001",
      name: "Aditi Sharma",
      email: "aditi.sharma@example.com",
      phone: "+919876543210",
      status: "ACTIVE",
      lifetimeValue: 24500000n, // ~₹2.45L historical LTV
      metadata: { seeded: true, scenario: "A" },
    })
    .returning();

  // 17 previous successful payments
  const paymentsToInsert = [];
  for (let i = 1; i <= 17; i++) {
    const occurredAt = new Date(now.getTime() - (60 - i * 3) * 86400 * 1000);
    paymentsToInsert.push({
      tenantId,
      customerId: customerA.id,
      amount: BigInt(prng.nextInt(120000, 350000)), // ₹1,200 - ₹3,500
      currency: "INR",
      status: "SUCCEEDED" as const,
      provider: "STRIPE",
      providerPaymentId: `pi_cus001_hist_succ_${i}`,
      occurredAt,
      paidAt: occurredAt,
      metadata: { seeded: true, scenario: "A", sequence: i },
    });
  }

  // 1 previous failure
  const failDate = new Date(now.getTime() - 40 * 86400 * 1000);
  paymentsToInsert.push({
    tenantId,
    customerId: customerA.id,
    amount: 199900n, // ₹1,999
    currency: "INR",
    status: "FAILED" as const,
    provider: "STRIPE",
    providerPaymentId: "pi_cus001_hist_fail_1",
    failureCode: "card_declined",
    failureMessage: "Your card was declined.",
    occurredAt: failDate,
    metadata: { seeded: true, scenario: "A", failure: true },
  });

  await db.insert(payments).values(paymentsToInsert);

  // Completed A-variant for dashboard richness (Spec 29 §Requirements 4)
  const completedPaymentDate = new Date(now.getTime() - 14 * 86400 * 1000);
  const [completedPayment] = await db
    .insert(payments)
    .values({
      tenantId,
      customerId: customerA.id,
      amount: 1299900n, // ₹12,999
      currency: "INR",
      status: "SUCCEEDED",
      provider: "STRIPE",
      providerPaymentId: "pi_cus001_completed_variant",
      occurredAt: completedPaymentDate,
      paidAt: completedPaymentDate,
      metadata: { seeded: true, scenario: "A-variant" },
    })
    .returning();

  const [completedCase] = await db
    .insert(recoveryCases)
    .values({
      tenantId,
      customerId: customerA.id,
      caseNumber: 9991,
      riskType: "PAYMENT_FAILURE",
      sourceEntityType: "PAYMENT",
      sourceEntityId: completedPayment.id,
      amountAtRisk: 1299900n,
      currency: "INR",
      riskScore: 86,
      band: "HIGH",
      status: "RECOVERED",
      tags: ["scenario-a", "historical-recovery"],
      metadata: { seeded: true, scenario: "A-variant" },
    })
    .returning();

  await db.insert(recoveryOutcomes).values({
    tenantId,
    caseId: completedCase.id,
    paymentId: completedPayment.id,
    baselineAmount: 1299900n,
    recoveredAmount: 1299900n,
    recoveryCost: 26000n, // ₹260 recovery cost
    attributionMethod: "PAYMENT_RETRY",
    attributionWindowHours: 72,
    recoveredAt: completedPaymentDate,
    metadata: { seeded: true, scenario: "A-variant" },
  });

  await db.insert(recoveryCostEntries).values([
    {
      tenantId,
      caseId: completedCase.id,
      category: "PAYMENT_PROCESSING",
      amount: 24000n,
      currency: "INR",
      incurredAt: completedPaymentDate,
      metadata: { provider: "STRIPE", feeType: "interchange" },
    },
    {
      tenantId,
      caseId: completedCase.id,
      category: "MESSAGING",
      amount: 2000n,
      currency: "INR",
      incurredAt: completedPaymentDate,
      metadata: { channel: "WHATSAPP", template: "payment_retry_notice" },
    },
  ]);

  // ===========================================================================
  // SCENARIO B: CUS-002 (Abandoned high-value checkout)
  // Cart: ₹7,999 (799900 paise). Active checkout duration: 4m 12s (252 seconds).
  // ===========================================================================
  const [customerB] = await db
    .insert(customers)
    .values({
      tenantId,
      externalRef: "CUS-002",
      name: "Rahul Verma",
      email: "rahul.verma@example.com",
      phone: "+919876543211",
      status: "ACTIVE",
      lifetimeValue: 8500000n,
      metadata: { seeded: true, scenario: "B" },
    })
    .returning();

  const checkoutStartedAt = new Date(now.getTime() - 252 * 1000); // 4m 12s ago
  await db.insert(checkouts).values({
    tenantId,
    customerId: customerB.id,
    cartValue: 799900n, // ₹7,999
    currency: "INR",
    sourceRef: "chk_scenario_b_pristine",
    status: "STARTED",
    startedAt: checkoutStartedAt,
    lastActivityAt: checkoutStartedAt,
    items: [
      {
        sku: "PRO-ANNUAL-REC",
        name: "Pro Annual Platform License",
        quantity: 1,
        unitPriceMinor: 799900,
      },
    ],
    metadata: { seeded: true, scenario: "B", durationSeconds: 252 },
  });

  // ===========================================================================
  // SCENARIO C: CUS-003 (Enterprise overdue invoice)
  // Invoice: ₹4,80,000 (48000000 paise). Days overdue: 7.
  // ===========================================================================
  const [customerC] = await db
    .insert(customers)
    .values({
      tenantId,
      externalRef: "CUS-003",
      name: "Acme Global Technologies",
      email: "billing@acme-global.com",
      phone: "+919876543212",
      status: "ACTIVE",
      lifetimeValue: 180000000n, // ₹18L historical LTV
      metadata: { seeded: true, scenario: "C", tier: "ENTERPRISE" },
    })
    .returning();

  const invoiceDueDate = new Date(now.getTime() - 7 * 86400 * 1000); // 7 days overdue
  const invoiceIssuedDate = new Date(now.getTime() - 37 * 86400 * 1000); // Net 30 terms
  await db.insert(invoices).values({
    tenantId,
    customerId: customerC.id,
    number: "INV-ENT-2026-003",
    amount: 48000000n, // ₹4,80,000
    amountPaid: 0n,
    currency: "INR",
    status: "OVERDUE",
    issuedAt: invoiceIssuedDate,
    dueAt: invoiceDueDate,
    providerInvoiceId: "in_scenario_c_enterprise",
    metadata: { seeded: true, scenario: "C", daysOverdue: 7 },
  });

  return {
    scenarioACustomerId: customerA.id,
    scenarioBCustomerId: customerB.id,
    scenarioCCustomerId: customerC.id,
    completedCaseId: completedCase.id,
  };
}
