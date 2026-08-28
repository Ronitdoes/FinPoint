import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  humanTasks,
  type HumanTask,
  type NewHumanTask,
} from "../schema/human-tasks";
import { type RepoContext, getExecutor } from "./types";

export interface CreateHumanTaskInput {
  tenantId: string;
  caseId: string;
  type: NewHumanTask["type"];
  title: string;
  description?: string;
  priority?: NewHumanTask["priority"];
  status?: NewHumanTask["status"];
  assignedTo?: string;
  slaDueAt?: Date;
  overdueAt?: Date;
  escalationCount?: number;
  decidedBy?: string;
  decisionNotes?: string;
  decidedAt?: Date;
  temporalSignalSent?: boolean;
}

export interface DecideHumanTaskInput {
  tenantId: string;
  taskId: string;
  status: HumanTask["status"];
  decidedBy: string;
  decisionNotes?: string;
  temporalSignalSent?: boolean;
}

export interface AssignHumanTaskInput {
  tenantId: string;
  taskId: string;
  assignedTo: string | null;
}

export interface CancelHumanTaskInput {
  tenantId: string;
  taskId: string;
  reason?: string;
}

export interface ListHumanTasksFiltersInput {
  tenantId: string;
  status?: HumanTask["status"];
  type?: HumanTask["type"];
  assignedTo?: string;
  overdue?: boolean;
  limit?: number;
  offset?: number;
}

export async function createHumanTask(
  ctx: RepoContext,
  input: CreateHumanTaskInput,
): Promise<HumanTask> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(humanTasks)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      type: input.type,
      title: input.title,
      description: input.description,
      priority: input.priority ?? "MEDIUM",
      status: input.status ?? "PENDING",
      assignedTo: input.assignedTo,
      slaDueAt: input.slaDueAt,
      overdueAt: input.overdueAt,
      escalationCount: input.escalationCount ?? 0,
      decidedBy: input.decidedBy,
      decisionNotes: input.decisionNotes,
      decidedAt: input.decidedAt,
      temporalSignalSent: input.temporalSignalSent ?? false,
    })
    .returning();
  return created;
}

export async function findHumanTaskById(
  ctx: RepoContext,
  { tenantId, taskId }: { tenantId: string; taskId: string },
): Promise<HumanTask | null> {
  const executor = getExecutor(ctx);
  const [task] = await executor
    .select()
    .from(humanTasks)
    .where(and(eq(humanTasks.tenantId, tenantId), eq(humanTasks.id, taskId)))
    .limit(1);
  return task ?? null;
}

export async function listPendingHumanTasks(
  ctx: RepoContext,
  {
    tenantId,
    limit = 50,
    offset = 0,
  }: { tenantId: string; limit?: number; offset?: number },
): Promise<HumanTask[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(humanTasks)
    .where(
      and(
        eq(humanTasks.tenantId, tenantId),
        eq(humanTasks.status, "PENDING"),
      ),
    )
    .orderBy(asc(humanTasks.slaDueAt))
    .limit(limit)
    .offset(offset);
}

export async function listHumanTasksForCase(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<HumanTask[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(humanTasks)
    .where(
      and(eq(humanTasks.tenantId, tenantId), eq(humanTasks.caseId, caseId)),
    )
    .orderBy(desc(humanTasks.createdAt));
}

/**
 * Filtered query for human tasks.
 */
export async function listHumanTasksWithFilters(
  ctx: RepoContext,
  input: ListHumanTasksFiltersInput,
): Promise<HumanTask[]> {
  const executor = getExecutor(ctx);
  const conditions = [eq(humanTasks.tenantId, input.tenantId)];

  if (input.status) {
    conditions.push(eq(humanTasks.status, input.status));
  }

  if (input.type) {
    conditions.push(eq(humanTasks.type, input.type));
  }

  if (input.assignedTo) {
    conditions.push(eq(humanTasks.assignedTo, input.assignedTo));
  }

  if (input.overdue !== undefined) {
    const now = new Date();
    if (input.overdue) {
      conditions.push(
        or(
          isNotNull(humanTasks.overdueAt),
          and(
            inArray(humanTasks.status, ["PENDING", "ASSIGNED"]),
            isNotNull(humanTasks.slaDueAt),
            lte(humanTasks.slaDueAt, now),
          ),
        )!,
      );
    } else {
      conditions.push(
        and(
          isNull(humanTasks.overdueAt),
          or(
            isNull(humanTasks.slaDueAt),
            gt(humanTasks.slaDueAt, now),
          ),
        )!,
      );
    }
  }

  return await executor
    .select()
    .from(humanTasks)
    .where(and(...conditions))
    .orderBy(asc(humanTasks.slaDueAt), desc(humanTasks.createdAt))
    .limit(input.limit ?? 50)
    .offset(input.offset ?? 0);
}

/**
 * Guarded decision update: only transitions from non-terminal states (PENDING, ASSIGNED).
 * Returns null if task is already in a terminal state (APPROVED, REJECTED, RESOLVED, CANCELLED).
 */
export async function decideHumanTask(
  ctx: RepoContext,
  input: DecideHumanTaskInput,
): Promise<HumanTask | null> {
  const executor = getExecutor(ctx);
  const now = new Date();
  const [updated] = await executor
    .update(humanTasks)
    .set({
      status: input.status,
      decidedBy: input.decidedBy,
      decisionNotes: input.decisionNotes,
      decidedAt: now,
      temporalSignalSent: input.temporalSignalSent ?? false,
      updatedAt: now,
    })
    .where(
      and(
        eq(humanTasks.tenantId, input.tenantId),
        eq(humanTasks.id, input.taskId),
        inArray(humanTasks.status, ["PENDING", "ASSIGNED"]),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Guarded assignment update: assigns task to user and marks status ASSIGNED.
 * Returns null if task is in a terminal state.
 */
export async function assignHumanTask(
  ctx: RepoContext,
  input: AssignHumanTaskInput,
): Promise<HumanTask | null> {
  const executor = getExecutor(ctx);
  const now = new Date();
  const [updated] = await executor
    .update(humanTasks)
    .set({
      assignedTo: input.assignedTo,
      status: "ASSIGNED",
      updatedAt: now,
    })
    .where(
      and(
        eq(humanTasks.tenantId, input.tenantId),
        eq(humanTasks.id, input.taskId),
        inArray(humanTasks.status, ["PENDING", "ASSIGNED"]),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Guarded cancellation: sets status CANCELLED.
 * Returns null if task is in a terminal state.
 */
export async function cancelHumanTask(
  ctx: RepoContext,
  input: CancelHumanTaskInput,
): Promise<HumanTask | null> {
  const executor = getExecutor(ctx);
  const now = new Date();
  const [updated] = await executor
    .update(humanTasks)
    .set({
      status: "CANCELLED",
      decisionNotes: input.reason,
      decidedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(humanTasks.tenantId, input.tenantId),
        eq(humanTasks.id, input.taskId),
        inArray(humanTasks.status, ["PENDING", "ASSIGNED"]),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function markSignalSent(
  ctx: RepoContext,
  { tenantId, taskId }: { tenantId: string; taskId: string },
): Promise<HumanTask | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(humanTasks)
    .set({
      temporalSignalSent: true,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(humanTasks.tenantId, tenantId),
        eq(humanTasks.id, taskId),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Finds tasks that have breached their SLA and have not yet been flagged as overdue.
 */
export async function findOverdueHumanTasks(
  ctx: RepoContext,
  {
    asOf = new Date(),
    limit = 100,
    tenantId,
  }: { asOf?: Date; limit?: number; tenantId?: string } = {},
): Promise<HumanTask[]> {
  const executor = getExecutor(ctx);
  const conditions = [
    inArray(humanTasks.status, ["PENDING", "ASSIGNED"]),
    isNotNull(humanTasks.slaDueAt),
    lte(humanTasks.slaDueAt, asOf),
    isNull(humanTasks.overdueAt),
  ];

  if (tenantId) {
    conditions.push(eq(humanTasks.tenantId, tenantId));
  }

  return await executor
    .select()
    .from(humanTasks)
    .where(and(...conditions))
    .orderBy(asc(humanTasks.slaDueAt))
    .limit(limit);
}

/**
 * Idempotently flags a task as overdue.
 */
export async function markTaskOverdue(
  ctx: RepoContext,
  {
    tenantId,
    taskId,
    overdueAt = new Date(),
  }: { tenantId: string; taskId: string; overdueAt?: Date },
): Promise<HumanTask | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(humanTasks)
    .set({
      overdueAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(humanTasks.tenantId, tenantId),
        eq(humanTasks.id, taskId),
        isNull(humanTasks.overdueAt),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Finds an existing task for a case by type within a time window (for 1h re-escalation deduplication).
 */
export async function findRecentHumanTaskForCase(
  ctx: RepoContext,
  {
    tenantId,
    caseId,
    type,
    since,
  }: { tenantId: string; caseId: string; type: NewHumanTask["type"]; since: Date },
): Promise<HumanTask | null> {
  const executor = getExecutor(ctx);
  const [task] = await executor
    .select()
    .from(humanTasks)
    .where(
      and(
        eq(humanTasks.tenantId, tenantId),
        eq(humanTasks.caseId, caseId),
        eq(humanTasks.type, type),
        gt(humanTasks.createdAt, since),
      ),
    )
    .orderBy(desc(humanTasks.createdAt))
    .limit(1);
  return task ?? null;
}

/**
 * Increments the escalation count for a human task.
 */
export async function incrementEscalationCount(
  ctx: RepoContext,
  { tenantId, taskId }: { tenantId: string; taskId: string },
): Promise<HumanTask | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(humanTasks)
    .set({
      escalationCount: sql`${humanTasks.escalationCount} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(humanTasks.tenantId, tenantId),
        eq(humanTasks.id, taskId),
      ),
    )
    .returning();
  return updated ?? null;
}
