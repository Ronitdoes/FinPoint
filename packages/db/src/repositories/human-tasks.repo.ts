import { and, asc, desc, eq } from "drizzle-orm";
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
  decidedBy?: string;
  decisionNotes?: string;
  decidedAt?: Date;
  temporalSignalSent?: boolean;
}

export interface DecideHumanTaskInput {
  tenantId: string;
  taskId: string;
  status: NewHumanTask["status"];
  decidedBy: string;
  decisionNotes?: string;
  temporalSignalSent?: boolean;
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

export async function decideHumanTask(
  ctx: RepoContext,
  input: DecideHumanTaskInput,
): Promise<HumanTask | null> {
  const executor = getExecutor(ctx);
  const [updated] = await executor
    .update(humanTasks)
    .set({
      status: input.status,
      decidedBy: input.decidedBy,
      decisionNotes: input.decisionNotes,
      decidedAt: new Date(),
      temporalSignalSent: input.temporalSignalSent ?? false,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(humanTasks.tenantId, input.tenantId),
        eq(humanTasks.id, input.taskId),
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
