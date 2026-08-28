import { and, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  recoveryActions,
  type RecoveryAction,
  type NewRecoveryAction,
} from "../schema/actions";
import { type RepoContext, getExecutor } from "./types";
import { DuplicateActionError, isUniqueViolation } from "./errors";

export interface InsertActionInput {
  tenantId: string;
  caseId: string;
  decisionId?: string;
  type: NewRecoveryAction["type"];
  parameters: Record<string, unknown>;
  status?: NewRecoveryAction["status"];
  policyResult?: Record<string, unknown>;
  attemptNumber?: number;
  idempotencyKey: string;
  scheduledAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface CompleteActionInput {
  tenantId: string;
  actionId: string;
  result?: Record<string, unknown>;
}

export interface FailActionInput {
  tenantId: string;
  actionId: string;
  error?: Record<string, unknown>;
}

/**
 * Inserts a recovery action. Throws DuplicateActionError if the unique idempotency key conflicts.
 */
export async function insertAction(
  ctx: RepoContext,
  input: InsertActionInput,
): Promise<RecoveryAction> {
  const executor = getExecutor(ctx);

  try {
    const [created] = await executor
      .insert(recoveryActions)
      .values({
        tenantId: input.tenantId,
        caseId: input.caseId,
        decisionId: input.decisionId,
        type: input.type,
        parameters: input.parameters,
        status: input.status ?? "PROPOSED",
        policyResult: input.policyResult,
        attemptNumber: input.attemptNumber ?? 1,
        idempotencyKey: input.idempotencyKey,
        scheduledAt: input.scheduledAt,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
        result: input.result,
        error: input.error,
      })
      .returning();

    return created;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DuplicateActionError(
        `Action with idempotency key '${input.idempotencyKey}' already exists`,
      );
    }
    throw error;
  }
}

/**
 * Atomically claims an action for execution.
 * Only transitions if status is PROPOSED or APPROVED and scheduled_at <= now() (or scheduled_at is null).
 * Returns null if another worker claimed it or state is invalid.
 */
export async function claimActionForExecution(
  ctx: RepoContext,
  { tenantId, actionId }: { tenantId: string; actionId: string },
): Promise<RecoveryAction | null> {
  const executor = getExecutor(ctx);
  const now = new Date();

  const [claimed] = await executor
    .update(recoveryActions)
    .set({
      status: "EXECUTING",
      startedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(recoveryActions.tenantId, tenantId),
        eq(recoveryActions.id, actionId),
        inArray(recoveryActions.status, ["PROPOSED", "APPROVED"]),
        or(
          isNull(recoveryActions.scheduledAt),
          lte(recoveryActions.scheduledAt, now),
        ),
      ),
    )
    .returning();

  return claimed ?? null;
}

/**
 * Transitions an EXECUTING action to EXECUTED status with execution results.
 * Returns null if action was not in EXECUTING state.
 */
export async function completeAction(
  ctx: RepoContext,
  input: CompleteActionInput,
): Promise<RecoveryAction | null> {
  const executor = getExecutor(ctx);
  const now = new Date();

  const [completed] = await executor
    .update(recoveryActions)
    .set({
      status: "EXECUTED",
      completedAt: now,
      result: input.result ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(recoveryActions.tenantId, input.tenantId),
        eq(recoveryActions.id, input.actionId),
        eq(recoveryActions.status, "EXECUTING"),
      ),
    )
    .returning();

  return completed ?? null;
}

/**
 * Transitions an EXECUTING action to FAILED status with error details.
 * Returns null if action was not in EXECUTING state.
 */
export async function failAction(
  ctx: RepoContext,
  input: FailActionInput,
): Promise<RecoveryAction | null> {
  const executor = getExecutor(ctx);
  const now = new Date();

  const [failed] = await executor
    .update(recoveryActions)
    .set({
      status: "FAILED",
      completedAt: now,
      error: input.error ?? null,
      updatedAt: now,
    })
    .where(
      and(
        eq(recoveryActions.tenantId, input.tenantId),
        eq(recoveryActions.id, input.actionId),
        eq(recoveryActions.status, "EXECUTING"),
      ),
    )
    .returning();

  return failed ?? null;
}

export async function findActionById(
  ctx: RepoContext,
  { tenantId, actionId }: { tenantId: string; actionId: string },
): Promise<RecoveryAction | null> {
  const executor = getExecutor(ctx);
  const [action] = await executor
    .select()
    .from(recoveryActions)
    .where(
      and(
        eq(recoveryActions.tenantId, tenantId),
        eq(recoveryActions.id, actionId),
      ),
    )
    .limit(1);
  return action ?? null;
}

export async function findActionByIdempotencyKey(
  ctx: RepoContext,
  { tenantId, idempotencyKey }: { tenantId: string; idempotencyKey: string },
): Promise<RecoveryAction | null> {
  const executor = getExecutor(ctx);
  const [action] = await executor
    .select()
    .from(recoveryActions)
    .where(
      and(
        eq(recoveryActions.tenantId, tenantId),
        eq(recoveryActions.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return action ?? null;
}

export async function listActionsForCase(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<RecoveryAction[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(recoveryActions)
    .where(
      and(
        eq(recoveryActions.tenantId, tenantId),
        eq(recoveryActions.caseId, caseId),
      ),
    )
    .orderBy(desc(recoveryActions.createdAt));
}
