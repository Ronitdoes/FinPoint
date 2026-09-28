import { and, desc, eq, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import {
  recoveryOutcomes,
  recoveryCostEntries,
  type RecoveryOutcome,
  type NewRecoveryOutcome,
  type RecoveryCostEntry,
  type NewRecoveryCostEntry,
} from "../schema/outcomes";
import { recoveryCases, type RecoveryCase } from "../schema/cases";
import { payments, type Payment } from "../schema/payments";
import { invoices, type Invoice } from "../schema/invoices";
import { checkouts, type Checkout } from "../schema/checkouts";
import { recoveryActions, type RecoveryAction } from "../schema/actions";
import { type RepoContext, getExecutor } from "./types";
import type { Tx } from "./tx";

export interface RecordOutcomeInput {
  tenantId: string;
  caseId: string;
  paymentId: string;
  baselineAmount: bigint;
  recoveredAmount: bigint;
  recoveryCost?: bigint;
  attributionMethod: string;
  attributionWindowHours: number;
  recoveredAt: Date;
  recordedAt?: Date;
}

export interface RecordCostEntryInput {
  tenantId: string;
  caseId: string;
  category: NewRecoveryCostEntry["category"];
  amount: bigint;
  currency: string;
  metadata?: Record<string, unknown>;
  incurredAt: Date;
  createdAt?: Date;
}

export interface ListOutcomesQuery {
  tenantId: string;
  from?: Date;
  to?: Date;
  surface?: string;
  method?: string;
  customerId?: string;
  limit?: number;
  cursor?: string;
}

export interface OutcomeAggregates {
  recovered_minor: bigint;
  cost_minor: bigint;
  net_minor: bigint;
  count: number;
}

export interface EnrichedOutcomeRow extends RecoveryOutcome {
  caseNumber?: number | null;
  riskType?: string | null;
  customerId?: string | null;
}

export interface ListOutcomesResult {
  items: EnrichedOutcomeRow[];
  aggregates: OutcomeAggregates;
  nextCursor?: string;
}

/**
 * Records an authoritative financial outcome inside a transaction.
 * Uses ON CONFLICT (case_id) DO NOTHING to enforce exactly one outcome per case idempotently.
 * Returns the recorded outcome (or existing outcome on idempotent replay).
 */
export async function recordOutcomeInTx(
  tx: Tx,
  input: RecordOutcomeInput,
): Promise<RecoveryOutcome> {
  const inserted = await tx
    .insert(recoveryOutcomes)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      paymentId: input.paymentId,
      baselineAmount: input.baselineAmount,
      recoveredAmount: input.recoveredAmount,
      recoveryCost: input.recoveryCost ?? 0n,
      attributionMethod: input.attributionMethod,
      attributionWindowHours: input.attributionWindowHours,
      recoveredAt: input.recoveredAt,
      recordedAt: input.recordedAt ?? new Date(),
    })
    .onConflictDoNothing({
      target: recoveryOutcomes.caseId,
    })
    .returning();

  if (inserted.length > 0) {
    return inserted[0]!;
  }

  // Row already existed: query and return the authoritative outcome
  const [existing] = await tx
    .select()
    .from(recoveryOutcomes)
    .where(
      and(
        eq(recoveryOutcomes.tenantId, input.tenantId),
        eq(recoveryOutcomes.caseId, input.caseId),
      ),
    )
    .limit(1);

  return existing!;
}

export async function recordOutcome(
  ctx: RepoContext,
  input: RecordOutcomeInput,
): Promise<RecoveryOutcome> {
  const executor = getExecutor(ctx);
  const inserted = await executor
    .insert(recoveryOutcomes)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      paymentId: input.paymentId,
      baselineAmount: input.baselineAmount,
      recoveredAmount: input.recoveredAmount,
      recoveryCost: input.recoveryCost ?? 0n,
      attributionMethod: input.attributionMethod,
      attributionWindowHours: input.attributionWindowHours,
      recoveredAt: input.recoveredAt,
      recordedAt: input.recordedAt ?? new Date(),
    })
    .onConflictDoNothing({
      target: recoveryOutcomes.caseId,
    })
    .returning();

  if (inserted.length > 0) {
    return inserted[0]!;
  }

  const [existing] = await executor
    .select()
    .from(recoveryOutcomes)
    .where(
      and(
        eq(recoveryOutcomes.tenantId, input.tenantId),
        eq(recoveryOutcomes.caseId, input.caseId),
      ),
    )
    .limit(1);

  return existing!;
}

export async function findOutcomeByCaseId(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<RecoveryOutcome | null> {
  const executor = getExecutor(ctx);
  const [outcome] = await executor
    .select()
    .from(recoveryOutcomes)
    .where(
      and(
        eq(recoveryOutcomes.tenantId, tenantId),
        eq(recoveryOutcomes.caseId, caseId),
      ),
    )
    .limit(1);
  return outcome ?? null;
}

/**
 * Computes the authoritative sum of all recovery cost entries for a case.
 * Returns 0n if no cost entries exist.
 */
export async function getRecoveryCostSumForCase(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<bigint> {
  const executor = getExecutor(ctx);
  const result = await executor.execute<{ total_cost: string }>(
    sql`SELECT COALESCE(SUM(amount), 0)::text AS total_cost FROM recovery_cost_entries WHERE tenant_id = ${tenantId} AND case_id = ${caseId}`,
  );
  const total = result[0]?.total_cost ?? "0";
  return BigInt(total);
}

/**
 * Appends a recovery cost entry to the immutable ledger (append-only).
 */
export async function recordCostEntry(
  ctx: RepoContext,
  input: RecordCostEntryInput,
): Promise<RecoveryCostEntry> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(recoveryCostEntries)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      category: input.category,
      amount: input.amount,
      currency: input.currency,
      metadata: input.metadata ?? {},
      incurredAt: input.incurredAt,
      createdAt: input.createdAt ?? new Date(),
    })
    .returning();
  return created;
}

/**
 * Lists chronological cost entries for a case (append-only reader).
 */
export async function listCostEntriesForCase(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<RecoveryCostEntry[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(recoveryCostEntries)
    .where(
      and(
        eq(recoveryCostEntries.tenantId, tenantId),
        eq(recoveryCostEntries.caseId, caseId),
      ),
    )
    .orderBy(desc(recoveryCostEntries.incurredAt));
}

export async function findOutcomesByCaseIds(
  ctx: RepoContext,
  { tenantId, caseIds }: { tenantId: string; caseIds: string[] },
): Promise<RecoveryOutcome[]> {
  if (!caseIds || caseIds.length === 0) return [];
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(recoveryOutcomes)
    .where(
      and(
        eq(recoveryOutcomes.tenantId, tenantId),
        inArray(recoveryOutcomes.caseId, caseIds),
      ),
    )
    .orderBy(desc(recoveryOutcomes.recoveredAt));
}

/**
 * Finds candidate closed/stopped cases without an outcome for the attribution sweeper (Spec 02 §9).
 *
 * CLOSED vs STOPPED/FAILED reconciliation (hygiene note, no semantic change):
 * older spec prose (s-26) says "STOPPED/CLOSED", but the domain state machine
 * (packages/domain/src/state-machines/recovery-case.ts) defines terminal states
 * as RECOVERED/STOPPED/FAILED — there is no CLOSED case status. Here CLOSED maps
 * to operator-closed STOPPED, and FAILED covers exhausted/terminal-failure cases;
 * RECOVERED is excluded (already has an outcome by invariant). Do NOT extend or
 * narrow this candidate set without spec sign-off.
 *
 * @allowCrossTenant - sweeper/admin read (optional tenantId lets the attribution
 *   sweeper scan across tenants; follow-up writes stay tenant-scoped)
 */
export async function findCandidateCasesForAttributionSweep(
  ctx: RepoContext,
  { tenantId, limit = 100 }: { tenantId?: string; limit?: number },
): Promise<RecoveryCase[]> {
  const executor = getExecutor(ctx);
  const conditions = [
    inArray(recoveryCases.status, ["STOPPED", "FAILED"]),
    sql`NOT EXISTS (SELECT 1 FROM recovery_outcomes ro WHERE ro.case_id = ${recoveryCases.id})`,
  ];
  if (tenantId) {
    conditions.push(eq(recoveryCases.tenantId, tenantId));
  }

  return await executor
    .select()
    .from(recoveryCases)
    .where(and(...conditions))
    .orderBy(desc(recoveryCases.openedAt))
    .limit(limit);
}

/**
 * Link-evidence helpers for strict INVOICE/CHECKOUT attribution (P1 fix).
 * Payments carry no dedicated invoice_id/checkout_id column, so obligation
 * linkage must come from methodMetadata keys or provider-reference equality.
 * All comparisons are string-normalized; tenant scoping is enforced by the
 * caller's baseConditions, amounts stay bigint minor units (CONVENTIONS §3).
 */
function metadataStringValues(methodMetadata: unknown): string[] {
  if (!methodMetadata || typeof methodMetadata !== "object") return [];
  return Object.values(methodMetadata as Record<string, unknown>).map((v) =>
    String(v ?? ""),
  );
}

function metadataHasAnyKey(
  methodMetadata: unknown,
  keys: string[],
  targets: Array<string | null | undefined>,
): boolean {
  if (!methodMetadata || typeof methodMetadata !== "object") return false;
  const mm = methodMetadata as Record<string, unknown>;
  const targetSet = new Set(
    targets.filter((t): t is string => typeof t === "string" && t.length > 0),
  );
  if (targetSet.size === 0) return false;
  for (const key of keys) {
    const raw = mm[key];
    if (raw === undefined || raw === null) continue;
    if (targetSet.has(String(raw))) return true;
  }
  return false;
}

const INVOICE_METADATA_KEYS = [
  "invoice_id",
  "invoiceId",
  "invoiceID",
  "provider_invoice_id",
  "providerInvoiceId",
  "invoice_number",
  "invoiceNumber",
  "number",
];

const CHECKOUT_METADATA_KEYS = [
  "checkout_id",
  "checkoutId",
  "source_ref",
  "sourceRef",
  "checkout_source_ref",
  "provider_reference",
  "providerReference",
];

export function isPaymentLinkedToInvoice(
  payment: Payment,
  invoice: Invoice,
  sourceEntityId: string,
): boolean {
  // Explicit payment-id equality (defensive: source holds an invoice UUID, so
  // this only fires if the obligation actually is the payment row).
  if (payment.id === sourceEntityId) return true;
  // Provider-reference equality: invoice's provider id paid via that provider payment.
  if (
    invoice.providerInvoiceId &&
    payment.providerPaymentId === invoice.providerInvoiceId
  ) {
    return true;
  }
  // methodMetadata linkage (invoice_id / provider_invoice_id / number, ...).
  if (
    metadataHasAnyKey(payment.methodMetadata, INVOICE_METADATA_KEYS, [
      invoice.id,
      invoice.providerInvoiceId,
      invoice.number,
    ])
  ) {
    return true;
  }
  // Fallback: any metadata value echoing the obligation identifiers.
  const values = new Set(metadataStringValues(payment.methodMetadata));
  if (values.has(invoice.id)) return true;
  if (invoice.providerInvoiceId && values.has(invoice.providerInvoiceId))
    return true;
  if (invoice.number && values.has(invoice.number)) return true;
  return false;
}

export function isPaymentLinkedToCheckout(
  payment: Payment,
  checkout: Checkout,
  sourceEntityId: string,
): boolean {
  if (payment.id === sourceEntityId) return true;
  if (
    checkout.sourceRef &&
    payment.providerPaymentId === checkout.sourceRef
  ) {
    return true;
  }
  if (
    metadataHasAnyKey(payment.methodMetadata, CHECKOUT_METADATA_KEYS, [
      checkout.id,
      checkout.sourceRef,
    ])
  ) {
    return true;
  }
  const values = new Set(metadataStringValues(payment.methodMetadata));
  if (values.has(checkout.id)) return true;
  if (checkout.sourceRef && values.has(checkout.sourceRef)) return true;
  return false;
}

/**
 * Evaluates the 4 attribution conditions for a candidate case against payments (Spec 02 §9):
 * 1. Same customer AND same financial obligation (payment ID, subscription ID, or source entity link)
 * 2. P.paid_at / occurredAt >= case.openedAt
 * 3. P.paid_at / occurredAt <= case.openedAt + attribution_window_hours
 * 4. No OTHER live case owns that obligation at attribution time
 */
export async function findMatchingPaymentForAttribution(
  ctx: RepoContext,
  { tenantId, caseRecord }: { tenantId: string; caseRecord: RecoveryCase },
): Promise<Payment | null> {
  const executor = getExecutor(ctx);
  const windowMs = caseRecord.attributionWindowHours * 60 * 60 * 1000;
  const windowEnd = new Date(caseRecord.openedAt.getTime() + windowMs);

  // Condition 4 check: verify no OTHER live case owns that obligation
  const otherLiveCases = await executor
    .select({ id: recoveryCases.id })
    .from(recoveryCases)
    .where(
      and(
        eq(recoveryCases.tenantId, tenantId),
        eq(recoveryCases.sourceEntityType, caseRecord.sourceEntityType),
        eq(recoveryCases.sourceEntityId, caseRecord.sourceEntityId),
        notInArray(recoveryCases.status, ["RECOVERED", "STOPPED", "FAILED"]),
        sql`${recoveryCases.id} != ${caseRecord.id}`,
      ),
    )
    .limit(1);

  if (otherLiveCases.length > 0) {
    // Condition 4 violated: newer or other live case owns the obligation
    return null;
  }

  // Find candidate succeeded payments for customer within window
  const baseConditions = [
    eq(payments.tenantId, tenantId),
    eq(payments.customerId, caseRecord.customerId),
    eq(payments.status, "SUCCEEDED"),
    gte(payments.occurredAt, caseRecord.openedAt),
    lte(payments.occurredAt, windowEnd),
  ];

  // Specific obligation linking (Condition 1)
  if (caseRecord.sourceEntityType === "PAYMENT") {
    // Succeeded payment is either the source payment itself or shares the same subscription
    const candidatePayments = await executor
      .select()
      .from(payments)
      .where(
        and(
          ...baseConditions,
          or(
            eq(payments.id, caseRecord.sourceEntityId),
            sql`${payments.subscriptionId} IS NOT NULL AND ${payments.subscriptionId} = (
              SELECT subscription_id FROM payments WHERE id = ${caseRecord.sourceEntityId} LIMIT 1
            )`,
          ),
        ),
      )
      .orderBy(desc(payments.occurredAt))
      .limit(1);

    return candidatePayments[0] ?? null;
  }

  if (caseRecord.sourceEntityType === "SUBSCRIPTION") {
    const candidatePayments = await executor
      .select()
      .from(payments)
      .where(
        and(...baseConditions, eq(payments.subscriptionId, caseRecord.sourceEntityId)),
      )
      .orderBy(desc(payments.occurredAt))
      .limit(1);

    return candidatePayments[0] ?? null;
  }

  // For INVOICE obligations, require an explicit obligation link. The prior
  // fallthrough matched ANY same-customer SUCCEEDED payment in-window, which
  // over-attributes unrelated payments. Link evidence (in order): explicit
  // payment-id equality, provider-reference equality
  // (invoice.providerInvoiceId === payment.providerPaymentId), or
  // methodMetadata invoice keys. Without a link, return null (no attribution).
  if (caseRecord.sourceEntityType === "INVOICE") {
    const [invoice] = await executor
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenantId),
          eq(invoices.id, caseRecord.sourceEntityId),
        ),
      )
      .limit(1);
    if (!invoice) return null;

    const candidates = await executor
      .select()
      .from(payments)
      .where(and(...baseConditions))
      .orderBy(desc(payments.occurredAt))
      .limit(50);

    for (const candidate of candidates) {
      if (
        isPaymentLinkedToInvoice(candidate, invoice, caseRecord.sourceEntityId)
      ) {
        return candidate;
      }
    }
    return null;
  }

  if (caseRecord.sourceEntityType === "CHECKOUT") {
    const [checkout] = await executor
      .select()
      .from(checkouts)
      .where(
        and(
          eq(checkouts.tenantId, tenantId),
          eq(checkouts.id, caseRecord.sourceEntityId),
        ),
      )
      .limit(1);
    if (!checkout) return null;

    const candidates = await executor
      .select()
      .from(payments)
      .where(and(...baseConditions))
      .orderBy(desc(payments.occurredAt))
      .limit(50);

    for (const candidate of candidates) {
      if (
        isPaymentLinkedToCheckout(
          candidate,
          checkout,
          caseRecord.sourceEntityId,
        )
      ) {
        return candidate;
      }
    }
    return null;
  }

  // Unknown/other source types: strict no-attribution. There is no defined
  // obligation-link semantics for these types, so matching any same-customer
  // payment would repeat the INVOICE/CHECKOUT over-attribution bug.
  return null;
}

/**
 * Filtered list of recovery outcomes with server-side SQL aggregates and cursor pagination (Spec 01 §25, Step 26).
 */
export async function listOutcomesWithAggregates(
  ctx: RepoContext,
  query: ListOutcomesQuery,
): Promise<ListOutcomesResult> {
  const executor = getExecutor(ctx);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

  const baseFilterConditions = [eq(recoveryOutcomes.tenantId, query.tenantId)];

  if (query.from) {
    baseFilterConditions.push(gte(recoveryOutcomes.recoveredAt, query.from));
  }
  if (query.to) {
    baseFilterConditions.push(lte(recoveryOutcomes.recoveredAt, query.to));
  }
  if (query.method) {
    baseFilterConditions.push(eq(recoveryOutcomes.attributionMethod, query.method));
  }
  if (query.surface) {
    baseFilterConditions.push(eq(recoveryCases.riskType, query.surface as any));
  }
  if (query.customerId) {
    baseFilterConditions.push(eq(recoveryCases.customerId, query.customerId));
  }

  // 1. Authoritative Aggregates Query strictly from stored database columns
  const [agg] = await executor
    .select({
      recovered_minor: sql<string>`COALESCE(SUM(${recoveryOutcomes.recoveredAmount}), 0)::text`,
      cost_minor: sql<string>`COALESCE(SUM(${recoveryOutcomes.recoveryCost}), 0)::text`,
      net_minor: sql<string>`COALESCE(SUM(${recoveryOutcomes.netRecovered}), 0)::text`,
      count: sql<string>`COUNT(*)::text`,
    })
    .from(recoveryOutcomes)
    .leftJoin(recoveryCases, eq(recoveryOutcomes.caseId, recoveryCases.id))
    .where(and(...baseFilterConditions));

  const aggregates: OutcomeAggregates = {
    recovered_minor: BigInt(agg?.recovered_minor ?? "0"),
    cost_minor: BigInt(agg?.cost_minor ?? "0"),
    net_minor: BigInt(agg?.net_minor ?? "0"),
    count: Number(agg?.count ?? 0),
  };

  // 2. Cursor Pagination Query
  const itemsConditions = [...baseFilterConditions];

  if (query.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString("utf8"),
      );
      if (decoded.recoveredAt && decoded.id) {
        const cursorDate = new Date(decoded.recoveredAt);
        itemsConditions.push(
          or(
            lt(recoveryOutcomes.recoveredAt, cursorDate),
            and(
              eq(recoveryOutcomes.recoveredAt, cursorDate),
              lt(recoveryOutcomes.id, decoded.id),
            ),
          )!,
        );
      }
    } catch {
      // Ignore invalid cursor
    }
  }

  const rows = await executor
    .select({
      id: recoveryOutcomes.id,
      tenantId: recoveryOutcomes.tenantId,
      caseId: recoveryOutcomes.caseId,
      paymentId: recoveryOutcomes.paymentId,
      baselineAmount: recoveryOutcomes.baselineAmount,
      recoveredAmount: recoveryOutcomes.recoveredAmount,
      recoveryCost: recoveryOutcomes.recoveryCost,
      netRecovered: recoveryOutcomes.netRecovered,
      attributionMethod: recoveryOutcomes.attributionMethod,
      attributionWindowHours: recoveryOutcomes.attributionWindowHours,
      recoveredAt: recoveryOutcomes.recoveredAt,
      recordedAt: recoveryOutcomes.recordedAt,
      createdAt: recoveryOutcomes.createdAt,
      updatedAt: recoveryOutcomes.updatedAt,
      caseNumber: recoveryCases.caseNumber,
      riskType: recoveryCases.riskType,
      customerId: recoveryCases.customerId,
    })
    .from(recoveryOutcomes)
    .leftJoin(recoveryCases, eq(recoveryOutcomes.caseId, recoveryCases.id))
    .where(and(...itemsConditions))
    .orderBy(desc(recoveryOutcomes.recoveredAt), desc(recoveryOutcomes.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | undefined;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1]!;
    nextCursor = Buffer.from(
      JSON.stringify({
        recoveredAt: lastItem.recoveredAt.toISOString(),
        id: lastItem.id,
      }),
      "utf8",
    ).toString("base64url");
  }

  return { items, aggregates, nextCursor };
}

/**
 * Audits executed recovery actions lacking corresponding cost entries (Spec 02 §8, Step 26).
 */
export async function findMissingActionCosts(
  ctx: RepoContext,
  { tenantId, limit = 100 }: { tenantId?: string; limit?: number },
): Promise<RecoveryAction[]> {
  const executor = getExecutor(ctx);
  const conditions = [
    eq(recoveryActions.status, "EXECUTED"),
    sql`NOT EXISTS (
      SELECT 1 FROM recovery_cost_entries rce 
      WHERE rce.case_id = ${recoveryActions.caseId}
      AND (
        (rce.metadata->>'action_id') = ${recoveryActions.id}::text
        OR (rce.category = 'MESSAGING' AND ${recoveryActions.type} IN ('SEND_WHATSAPP', 'SEND_EMAIL', 'SEND_SMS'))
      )
    )`,
  ];

  if (tenantId) {
    conditions.push(eq(recoveryActions.tenantId, tenantId));
  }

  return await executor
    .select()
    .from(recoveryActions)
    .where(and(...conditions))
    .orderBy(desc(recoveryActions.completedAt))
    .limit(limit);
}

