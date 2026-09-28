import { and, desc, eq, gte, lte, lt, or } from "drizzle-orm";
import {
  revenueRisks,
  type RevenueRisk,
  type NewRevenueRisk,
} from "../schema/risks";
import { type RepoContext, getExecutor } from "./types";

export interface CreateRevenueRiskInput {
  tenantId: string;
  customerId: string;
  riskType: NewRevenueRisk["riskType"];
  subjectType: string;
  subjectId: string;
  score: number;
  band: NewRevenueRisk["band"];
  factors: Record<string, unknown>;
  status?: NewRevenueRisk["status"];
  computedAt: Date;
  expiresAt?: Date;
}

export interface UpdateRiskStatusInput {
  tenantId: string;
  riskId: string;
  status: NewRevenueRisk["status"];
}

export interface UpsertOpenRiskInput {
  tenantId: string;
  customerId: string;
  riskType: NewRevenueRisk["riskType"];
  subjectType: string;
  subjectId: string;
  score: number;
  band: NewRevenueRisk["band"];
  factors: Record<string, unknown>;
  computedAt: Date;
  expiresAt?: Date;
}

export interface CloseRisksForSubjectInput {
  tenantId: string;
  subjectType: string;
  subjectId: string;
  reason?: string;
}

export interface ListRisksQuery {
  tenantId: string;
  status?: NewRevenueRisk["status"];
  band?: NewRevenueRisk["band"];
  riskType?: NewRevenueRisk["riskType"];
  customerId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export interface ListRisksResult {
  items: RevenueRisk[];
  nextCursor?: string;
}

export async function createRevenueRisk(
  ctx: RepoContext,
  input: CreateRevenueRiskInput,
): Promise<RevenueRisk> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(revenueRisks)
    .values({
      tenantId: input.tenantId,
      customerId: input.customerId,
      riskType: input.riskType,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      score: input.score,
      band: input.band,
      factors: input.factors,
      status: input.status ?? "OPEN",
      computedAt: input.computedAt,
      expiresAt: input.expiresAt,
    })
    .returning();
  return created;
}

/**
 * Idempotently computes/updates OPEN risk for a subject anchor (tenantId, subjectType, subjectId).
 * Recomputation replaces OPEN risk and bumps computed_at.
 * Terminal risks (ASSESSED, EXPIRED) are never resurrected.
 * Race-safe (s-12 fix): partial unique index on OPEN per subject + 23505
 * fallback re-read, so concurrent redeliveries cannot insert duplicates.
 */
export async function upsertOpenRisk(
  ctx: RepoContext,
  input: UpsertOpenRiskInput,
): Promise<RevenueRisk> {
  const executor = getExecutor(ctx);

  // 1. Check for existing OPEN risk for this subject
  const [existingOpen] = await executor
    .select()
    .from(revenueRisks)
    .where(
      and(
        eq(revenueRisks.tenantId, input.tenantId),
        eq(revenueRisks.subjectType, input.subjectType),
        eq(revenueRisks.subjectId, input.subjectId),
        eq(revenueRisks.status, "OPEN"),
      ),
    )
    .limit(1);

  if (existingOpen) {
    const [updated] = await executor
      .update(revenueRisks)
      .set({
        customerId: input.customerId,
        riskType: input.riskType,
        score: input.score,
        band: input.band,
        factors: input.factors,
        computedAt: input.computedAt,
        expiresAt: input.expiresAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(revenueRisks.tenantId, input.tenantId),
          eq(revenueRisks.id, existingOpen.id),
          eq(revenueRisks.status, "OPEN"),
        ),
      )
      .returning();

    return updated ?? existingOpen;
  }

  // 2. Check if a terminal risk exists for this subject
  const [existingTerminal] = await executor
    .select()
    .from(revenueRisks)
    .where(
      and(
        eq(revenueRisks.tenantId, input.tenantId),
        eq(revenueRisks.subjectType, input.subjectType),
        eq(revenueRisks.subjectId, input.subjectId),
      ),
    )
    .orderBy(desc(revenueRisks.computedAt))
    .limit(1);

  if (existingTerminal && existingTerminal.status !== "OPEN") {
    // Terminal risks never resurrect (Spec 01 §8, s-12 §Requirements 5)
    return existingTerminal;
  }

  // 3. No existing risk -> create a new OPEN risk (race-safe: 23505 -> re-read winner)
  try {
    const [created] = await executor
      .insert(revenueRisks)
      .values({
        tenantId: input.tenantId,
        customerId: input.customerId,
        riskType: input.riskType,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        score: input.score,
        band: input.band,
        factors: input.factors,
        status: "OPEN",
        computedAt: input.computedAt,
        expiresAt: input.expiresAt,
      })
      .returning();

    return created;
  } catch (err: any) {
    // Partial-unique violation on OPEN per subject: loser re-reads winner.
    if (err?.code === "23505") {
      const [winner] = await executor
        .select()
        .from(revenueRisks)
        .where(
          and(
            eq(revenueRisks.tenantId, input.tenantId),
            eq(revenueRisks.subjectType, input.subjectType),
            eq(revenueRisks.subjectId, input.subjectId),
            eq(revenueRisks.status, "OPEN"),
          ),
        )
        .limit(1);
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Closes all OPEN risks for a subject on resolution events (payment.succeeded, invoice.paid, checkout.completed).
 * Marks matching OPEN risks as EXPIRED.
 */
export async function closeRisksForSubject(
  ctx: RepoContext,
  input: CloseRisksForSubjectInput,
): Promise<RevenueRisk[]> {
  const executor = getExecutor(ctx);

  const updated = await executor
    .update(revenueRisks)
    .set({
      status: "EXPIRED",
      expiresAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(revenueRisks.tenantId, input.tenantId),
        eq(revenueRisks.subjectType, input.subjectType),
        eq(revenueRisks.subjectId, input.subjectId),
        eq(revenueRisks.status, "OPEN"),
      ),
    )
    .returning();

  return updated;
}

export async function findRevenueRiskById(
  ctx: RepoContext,
  { tenantId, riskId }: { tenantId: string; riskId: string },
): Promise<RevenueRisk | null> {
  const executor = getExecutor(ctx);
  const [risk] = await executor
    .select()
    .from(revenueRisks)
    .where(
      and(eq(revenueRisks.tenantId, tenantId), eq(revenueRisks.id, riskId)),
    )
    .limit(1);
  return risk ?? null;
}

export async function findLatestRiskForSubject(
  ctx: RepoContext,
  {
    tenantId,
    subjectType,
    subjectId,
  }: { tenantId: string; subjectType: string; subjectId: string },
): Promise<RevenueRisk | null> {
  const executor = getExecutor(ctx);
  const [risk] = await executor
    .select()
    .from(revenueRisks)
    .where(
      and(
        eq(revenueRisks.tenantId, tenantId),
        eq(revenueRisks.subjectType, subjectType),
        eq(revenueRisks.subjectId, subjectId),
      ),
    )
    .orderBy(desc(revenueRisks.computedAt))
    .limit(1);
  return risk ?? null;
}

export async function updateRiskStatus(
  ctx: RepoContext,
  input: UpdateRiskStatusInput,
): Promise<RevenueRisk | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(revenueRisks)
    .set({
      status: input.status,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(revenueRisks.tenantId, input.tenantId),
        eq(revenueRisks.id, input.riskId),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function listRisksForCustomer(
  ctx: RepoContext,
  {
    tenantId,
    customerId,
    limit = 50,
    offset = 0,
  }: { tenantId: string; customerId: string; limit?: number; offset?: number },
): Promise<RevenueRisk[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(revenueRisks)
    .where(
      and(
        eq(revenueRisks.tenantId, tenantId),
        eq(revenueRisks.customerId, customerId),
      ),
    )
    .orderBy(desc(revenueRisks.computedAt))
    .limit(limit)
    .offset(offset);
}

/**
 * Filtered list of risks with cursor-based pagination and strict tenant isolation.
 * Supports filtering by status, band, riskType, customerId, from, and to.
 */
export async function listRisks(
  ctx: RepoContext,
  query: ListRisksQuery,
): Promise<ListRisksResult> {
  const executor = getExecutor(ctx);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);

  const conditions = [eq(revenueRisks.tenantId, query.tenantId)];

  if (query.status) {
    conditions.push(eq(revenueRisks.status, query.status));
  }
  if (query.band) {
    conditions.push(eq(revenueRisks.band, query.band));
  }
  if (query.riskType) {
    conditions.push(eq(revenueRisks.riskType, query.riskType));
  }
  if (query.customerId) {
    conditions.push(eq(revenueRisks.customerId, query.customerId));
  }
  if (query.from) {
    conditions.push(gte(revenueRisks.computedAt, query.from));
  }
  if (query.to) {
    conditions.push(lte(revenueRisks.computedAt, query.to));
  }

  if (query.cursor) {
    try {
      const decoded = JSON.parse(
        Buffer.from(query.cursor, "base64url").toString("utf8"),
      );
      if (decoded.computedAt && decoded.id) {
        const cursorDate = new Date(decoded.computedAt);
        conditions.push(
          or(
            lt(revenueRisks.computedAt, cursorDate),
            and(
              eq(revenueRisks.computedAt, cursorDate),
              lt(revenueRisks.id, decoded.id),
            ),
          )!,
        );
      }
    } catch {
      // Invalid cursor ignored / treated as from beginning
    }
  }

  const rows = await executor
    .select()
    .from(revenueRisks)
    .where(and(...conditions))
    .orderBy(desc(revenueRisks.computedAt), desc(revenueRisks.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;

  let nextCursor: string | undefined;
  if (hasMore && items.length > 0) {
    const lastItem = items[items.length - 1];
    nextCursor = Buffer.from(
      JSON.stringify({
        computedAt: lastItem.computedAt.toISOString(),
        id: lastItem.id,
      }),
      "utf8",
    ).toString("base64url");
  }

  return { items, nextCursor };
}
