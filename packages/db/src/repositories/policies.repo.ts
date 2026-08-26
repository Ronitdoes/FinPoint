import { and, desc, eq, isNull, or } from "drizzle-orm";
import {
  policyRules,
  policyVersions,
  policyEvaluations,
  type PolicyRule,
  type NewPolicyRule,
  type PolicyVersion,
  type NewPolicyVersion,
  type PolicyEvaluation,
  type NewPolicyEvaluation,
} from "../schema/policies";
import { type RepoContext, getExecutor } from "./types";

export interface CreatePolicyRuleInput {
  tenantId?: string | null;
  code: string;
  name: string;
  description?: string;
  ruleKind: NewPolicyRule["ruleKind"];
  definition: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdatePolicyRuleInput {
  ruleId: string;
  tenantId?: string;
  name?: string;
  description?: string;
  definition?: Record<string, unknown>;
  enabled?: boolean;
}

export interface CreatePolicyVersionInput {
  ruleId: string;
  version: number;
  snapshot: Record<string, unknown>;
  createdBy?: string;
}

export interface RecordPolicyEvaluationInput {
  tenantId: string;
  caseId?: string;
  decisionId?: string;
  ruleVersions: string[];
  result: NewPolicyEvaluation["result"];
  rejections?: unknown[];
  effectiveActions: unknown[];
  latencyMs: number;
  evaluatedAt?: Date;
}

export async function createPolicyRule(
  ctx: RepoContext,
  input: CreatePolicyRuleInput,
): Promise<PolicyRule> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(policyRules)
    .values({
      tenantId: input.tenantId ?? null,
      code: input.code,
      name: input.name,
      description: input.description,
      ruleKind: input.ruleKind,
      definition: input.definition,
      enabled: input.enabled ?? true,
    })
    .returning();
  return created;
}

export async function findPolicyRuleByCode(
  ctx: RepoContext,
  { code, tenantId }: { code: string; tenantId?: string },
): Promise<PolicyRule | null> {
  const executor = getExecutor(ctx);
  const conditions = [eq(policyRules.code, code)];
  if (tenantId !== undefined) {
    conditions.push(or(eq(policyRules.tenantId, tenantId), isNull(policyRules.tenantId))!);
  }

  const [rule] = await executor
    .select()
    .from(policyRules)
    .where(and(...conditions))
    .limit(1);
  return rule ?? null;
}

export async function findPolicyRuleById(
  ctx: RepoContext,
  { ruleId }: { ruleId: string },
): Promise<PolicyRule | null> {
  const executor = getExecutor(ctx);
  const [rule] = await executor
    .select()
    .from(policyRules)
    .where(eq(policyRules.id, ruleId))
    .limit(1);
  return rule ?? null;
}

export async function listPolicyRules(
  ctx: RepoContext,
  { tenantId }: { tenantId?: string } = {},
): Promise<PolicyRule[]> {
  const executor = getExecutor(ctx);
  if (tenantId) {
    return await executor
      .select()
      .from(policyRules)
      .where(or(eq(policyRules.tenantId, tenantId), isNull(policyRules.tenantId)));
  }
  return await executor.select().from(policyRules);
}

export async function updatePolicyRule(
  ctx: RepoContext,
  input: UpdatePolicyRuleInput,
): Promise<PolicyRule | null> {
  const executor = getExecutor(ctx);
  const updateData: Partial<NewPolicyRule> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) updateData.name = input.name;
  if (input.description !== undefined) updateData.description = input.description;
  if (input.definition !== undefined) updateData.definition = input.definition;
  if (input.enabled !== undefined) updateData.enabled = input.enabled;

  const conditions = [eq(policyRules.id, input.ruleId)];
  if (input.tenantId) {
    conditions.push(eq(policyRules.tenantId, input.tenantId));
  }

  const [updated] = await executor
    .update(policyRules)
    .set(updateData)
    .where(and(...conditions))
    .returning();
  return updated ?? null;
}

/**
 * Creates an immutable snapshot version of a policy rule definition (append-only).
 */
export async function createPolicyVersion(
  ctx: RepoContext,
  input: CreatePolicyVersionInput,
): Promise<PolicyVersion> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(policyVersions)
    .values({
      ruleId: input.ruleId,
      version: input.version,
      snapshot: input.snapshot,
      createdBy: input.createdBy,
    })
    .returning();
  return created;
}

export async function getLatestPolicyVersion(
  ctx: RepoContext,
  { ruleId }: { ruleId: string },
): Promise<PolicyVersion | null> {
  const executor = getExecutor(ctx);
  const [version] = await executor
    .select()
    .from(policyVersions)
    .where(eq(policyVersions.ruleId, ruleId))
    .orderBy(desc(policyVersions.version))
    .limit(1);
  return version ?? null;
}

export async function listPolicyVersions(
  ctx: RepoContext,
  { ruleId }: { ruleId: string },
): Promise<PolicyVersion[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(policyVersions)
    .where(eq(policyVersions.ruleId, ruleId))
    .orderBy(desc(policyVersions.version));
}

/**
 * Appends a policy evaluation audit record (append-only).
 */
export async function recordPolicyEvaluation(
  ctx: RepoContext,
  input: RecordPolicyEvaluationInput,
): Promise<PolicyEvaluation> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(policyEvaluations)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      decisionId: input.decisionId,
      ruleVersions: input.ruleVersions,
      result: input.result,
      rejections: input.rejections ?? [],
      effectiveActions: input.effectiveActions,
      latencyMs: input.latencyMs,
      evaluatedAt: input.evaluatedAt ?? new Date(),
    })
    .returning();
  return created;
}

export async function listPolicyEvaluationsForCase(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<PolicyEvaluation[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(policyEvaluations)
    .where(
      and(
        eq(policyEvaluations.tenantId, tenantId),
        eq(policyEvaluations.caseId, caseId),
      ),
    )
    .orderBy(desc(policyEvaluations.evaluatedAt));
}
