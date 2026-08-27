import { and, desc, eq } from "drizzle-orm";
import {
  aiDecisions,
  type AiDecision,
  type NewAiDecision,
} from "../schema/decisions";
import { type RepoContext, getExecutor } from "./types";

export interface CreateDecisionInput {
  tenantId: string;
  caseId: string;
  model: string;
  modelVersion?: string;
  promptVersion: string;
  inputSnapshot: Record<string, unknown>;
  outputRaw?: Record<string, unknown>;
  diagnosisCause?: string;
  diagnosisConfidence?: string; // numeric in drizzle
  recommendedActions: unknown[];
  stopConditions?: string[];
  status: NewAiDecision["status"];
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costMinorUnits?: bigint;
  error?: string;
}

export async function createDecision(
  ctx: RepoContext,
  input: CreateDecisionInput,
): Promise<AiDecision> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(aiDecisions)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      model: input.model,
      modelVersion: input.modelVersion,
      promptVersion: input.promptVersion,
      inputSnapshot: input.inputSnapshot,
      outputRaw: input.outputRaw,
      diagnosisCause: input.diagnosisCause,
      diagnosisConfidence: input.diagnosisConfidence,
      recommendedActions: input.recommendedActions,
      stopConditions: input.stopConditions ?? [],
      status: input.status,
      latencyMs: input.latencyMs,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      costMinorUnits: input.costMinorUnits ?? 0n,
      error: input.error,
    })
    .returning();
  return created;
}

export async function findDecisionById(
  ctx: RepoContext,
  { tenantId, decisionId }: { tenantId: string; decisionId: string },
): Promise<AiDecision | null> {
  const executor = getExecutor(ctx);
  const [decision] = await executor
    .select()
    .from(aiDecisions)
    .where(
      and(eq(aiDecisions.tenantId, tenantId), eq(aiDecisions.id, decisionId)),
    )
    .limit(1);
  return decision ?? null;
}

export async function listDecisionsForCase(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<AiDecision[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(aiDecisions)
    .where(
      and(eq(aiDecisions.tenantId, tenantId), eq(aiDecisions.caseId, caseId)),
    )
    .orderBy(desc(aiDecisions.createdAt));
}

export async function findLatestDecisionForCase(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<AiDecision | null> {
  const executor = getExecutor(ctx);
  const [decision] = await executor
    .select()
    .from(aiDecisions)
    .where(
      and(eq(aiDecisions.tenantId, tenantId), eq(aiDecisions.caseId, caseId)),
    )
    .orderBy(desc(aiDecisions.createdAt))
    .limit(1);
  return decision ?? null;
}

export interface ListDecisionsOptions {
  tenantId: string;
  caseId?: string;
  status?: NewAiDecision["status"];
  limit?: number;
  offset?: number;
}

/**
 * Lists decisions with optional caseId, status filter, and pagination (Spec 01 §10, Step 15).
 */
export async function listDecisions(
  ctx: RepoContext,
  opts: ListDecisionsOptions,
): Promise<AiDecision[]> {
  const executor = getExecutor(ctx);
  const conditions = [eq(aiDecisions.tenantId, opts.tenantId)];

  if (opts.caseId) {
    conditions.push(eq(aiDecisions.caseId, opts.caseId));
  }
  if (opts.status) {
    conditions.push(eq(aiDecisions.status, opts.status));
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  return await executor
    .select()
    .from(aiDecisions)
    .where(and(...conditions))
    .orderBy(desc(aiDecisions.createdAt))
    .limit(limit)
    .offset(offset);
}

