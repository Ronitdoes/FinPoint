import { and, desc, eq } from "drizzle-orm";
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
