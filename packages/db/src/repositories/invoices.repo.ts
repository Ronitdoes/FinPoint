import { and, desc, eq, sql } from "drizzle-orm";
import {
  invoices,
  invoiceEvents,
  type Invoice,
  type NewInvoice,
  type InvoiceEvent,
  type NewInvoiceEvent,
} from "../schema/invoices";
import { recoveryCases } from "../schema/cases";
import { type RepoContext, getExecutor } from "./types";

export interface CreateInvoiceInput {
  tenantId: string;
  customerId: string;
  number: string;
  amount: bigint;
  amountPaid?: bigint;
  currency: string;
  status?: NewInvoice["status"];
  issuedAt?: Date;
  dueAt: Date;
  paidAt?: Date;
  disputedAt?: Date;
  provider?: NewInvoice["provider"];
  providerInvoiceId?: string;
}

export interface UpdateInvoiceStatusInput {
  tenantId: string;
  invoiceId: string;
  status: NewInvoice["status"];
  amountPaid?: bigint;
  paidAt?: Date;
  disputedAt?: Date;
}

export interface RecordInvoiceEventInput {
  tenantId: string;
  invoiceId: string;
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

export async function createInvoice(
  ctx: RepoContext,
  input: CreateInvoiceInput,
): Promise<Invoice> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(invoices)
    .values({
      tenantId: input.tenantId,
      customerId: input.customerId,
      number: input.number,
      amount: input.amount,
      amountPaid: input.amountPaid ?? 0n,
      currency: input.currency,
      status: input.status ?? "DRAFT",
      issuedAt: input.issuedAt,
      dueAt: input.dueAt,
      paidAt: input.paidAt,
      disputedAt: input.disputedAt,
      provider: input.provider,
      providerInvoiceId: input.providerInvoiceId,
    })
    .returning();
  return created;
}

export async function findInvoiceById(
  ctx: RepoContext,
  { tenantId, invoiceId }: { tenantId: string; invoiceId: string },
): Promise<Invoice | null> {
  const executor = getExecutor(ctx);
  const [invoice] = await executor
    .select()
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceId)))
    .limit(1);
  return invoice ?? null;
}

export async function findInvoiceByNumber(
  ctx: RepoContext,
  { tenantId, number }: { tenantId: string; number: string },
): Promise<Invoice | null> {
  const executor = getExecutor(ctx);
  const [invoice] = await executor
    .select()
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.number, number)))
    .limit(1);
  return invoice ?? null;
}

export async function findInvoiceByProviderId(
  ctx: RepoContext,
  {
    tenantId,
    provider,
    providerInvoiceId,
  }: {
    tenantId: string;
    provider: NonNullable<NewInvoice["provider"]>;
    providerInvoiceId: string;
  },
): Promise<Invoice | null> {
  const executor = getExecutor(ctx);
  const [invoice] = await executor
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        eq(invoices.provider, provider),
        eq(invoices.providerInvoiceId, providerInvoiceId),
      ),
    )
    .limit(1);
  return invoice ?? null;
}

export async function updateInvoiceStatus(
  ctx: RepoContext,
  input: UpdateInvoiceStatusInput,
): Promise<Invoice | null> {
  const executor = getExecutor(ctx);
  const updateData: Partial<NewInvoice> = {
    status: input.status,
    updatedAt: new Date(),
  };
  if (input.amountPaid !== undefined) updateData.amountPaid = input.amountPaid;
  if (input.paidAt !== undefined) updateData.paidAt = input.paidAt;
  if (input.disputedAt !== undefined) updateData.disputedAt = input.disputedAt;

  const [updated] = await executor
    .update(invoices)
    .set(updateData)
    .where(and(eq(invoices.tenantId, input.tenantId), eq(invoices.id, input.invoiceId)))
    .returning();
  return updated ?? null;
}

/**
 * Appends an invoice event to the immutable invoice timeline (append-only).
 */
export async function recordInvoiceEvent(
  ctx: RepoContext,
  input: RecordInvoiceEventInput,
): Promise<InvoiceEvent> {
  const executor = getExecutor(ctx);
  const [event] = await executor
    .insert(invoiceEvents)
    .values({
      invoiceId: input.invoiceId,
      type: input.type,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();
  return event;
}

/**
 * Lists chronological invoice events for an invoice (append-only reader).
 */
export async function listInvoiceEvents(
  ctx: RepoContext,
  { invoiceId }: { invoiceId: string },
): Promise<InvoiceEvent[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(invoiceEvents)
    .where(eq(invoiceEvents.invoiceId, invoiceId))
    .orderBy(invoiceEvents.occurredAt);
}

export async function listInvoicesForCustomer(
  ctx: RepoContext,
  {
    tenantId,
    customerId,
    limit = 50,
    offset = 0,
  }: { tenantId: string; customerId: string; limit?: number; offset?: number },
): Promise<Invoice[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.customerId, customerId)))
    .orderBy(desc(invoices.dueAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Finds OVERDUE invoices that have no active recovery case (missed webhook safety net / reconciliation).
 */
export async function findOrphanedOverdueInvoices(
  ctx: RepoContext,
  {
    tenantId,
    limit = 50,
    offset = 0,
  }: { tenantId: string; limit?: number; offset?: number },
): Promise<Invoice[]> {
  const executor = getExecutor(ctx);
  const rows = await executor
    .select({ invoice: invoices })
    .from(invoices)
    .leftJoin(
      recoveryCases,
      and(
        eq(recoveryCases.tenantId, invoices.tenantId),
        eq(recoveryCases.sourceEntityType, "INVOICE"),
        eq(recoveryCases.sourceEntityId, invoices.id),
        sql`${recoveryCases.status} NOT IN ('RECOVERED', 'STOPPED', 'FAILED')`,
      ),
    )
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        eq(invoices.status, "OVERDUE"),
        sql`${recoveryCases.id} IS NULL`,
      ),
    )
    .orderBy(invoices.dueAt)
    .limit(limit)
    .offset(offset);

  return rows.map((r) => r.invoice);
}


