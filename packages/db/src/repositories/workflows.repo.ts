import { and, eq } from "drizzle-orm";
import {
  workflows,
  workflowEvents,
  type Workflow,
  type NewWorkflow,
  type WorkflowEvent,
  type NewWorkflowEvent,
} from "../schema/workflows";
import { type RepoContext, getExecutor } from "./types";

export interface CreateWorkflowInput {
  tenantId: string;
  caseId: string;
  temporalWorkflowId: string;
  runId?: string;
  type: string;
  status?: NewWorkflow["status"];
  startedAt?: Date;
  closedAt?: Date;
}

export interface UpdateWorkflowStatusInput {
  tenantId: string;
  workflowId: string;
  status: NewWorkflow["status"];
  runId?: string;
  closedAt?: Date;
}

export interface RecordWorkflowEventInput {
  workflowRowId: string;
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

export async function createWorkflow(
  ctx: RepoContext,
  input: CreateWorkflowInput,
): Promise<Workflow> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(workflows)
    .values({
      tenantId: input.tenantId,
      caseId: input.caseId,
      temporalWorkflowId: input.temporalWorkflowId,
      runId: input.runId,
      type: input.type,
      status: input.status ?? "RUNNING",
      startedAt: input.startedAt ?? new Date(),
      closedAt: input.closedAt,
    })
    .returning();
  return created;
}

export async function findWorkflowById(
  ctx: RepoContext,
  { tenantId, workflowId }: { tenantId: string; workflowId: string },
): Promise<Workflow | null> {
  const executor = getExecutor(ctx);
  const [workflow] = await executor
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.tenantId, tenantId), eq(workflows.id, workflowId)),
    )
    .limit(1);
  return workflow ?? null;
}

export async function findWorkflowByCaseId(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<Workflow | null> {
  const executor = getExecutor(ctx);
  const [workflow] = await executor
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.tenantId, tenantId), eq(workflows.caseId, caseId)),
    )
    .limit(1);
  return workflow ?? null;
}

export async function findWorkflowByTemporalId(
  ctx: RepoContext,
  {
    tenantId,
    temporalWorkflowId,
  }: { tenantId: string; temporalWorkflowId: string },
): Promise<Workflow | null> {
  const executor = getExecutor(ctx);
  const [workflow] = await executor
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenantId, tenantId),
        eq(workflows.temporalWorkflowId, temporalWorkflowId),
      ),
    )
    .limit(1);
  return workflow ?? null;
}

export async function updateWorkflowStatus(
  ctx: RepoContext,
  input: UpdateWorkflowStatusInput,
): Promise<Workflow | null> {
  const executor = getExecutor(ctx);
  const updateData: Partial<NewWorkflow> = {
    status: input.status,
    updatedAt: new Date(),
  };
  if (input.runId !== undefined) updateData.runId = input.runId;
  if (input.closedAt !== undefined) updateData.closedAt = input.closedAt;

  const [updated] = await executor
    .update(workflows)
    .set(updateData)
    .where(
      and(
        eq(workflows.tenantId, input.tenantId),
        eq(workflows.id, input.workflowId),
      ),
    )
    .returning();
  return updated ?? null;
}

/**
 * Appends a workflow step event to the timeline ledger (append-only).
 */
export async function recordWorkflowEvent(
  ctx: RepoContext,
  input: RecordWorkflowEventInput,
): Promise<WorkflowEvent> {
  const executor = getExecutor(ctx);
  const [event] = await executor
    .insert(workflowEvents)
    .values({
      workflowRowId: input.workflowRowId,
      type: input.type,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt ?? new Date(),
    })
    .returning();
  return event;
}

/**
 * Lists chronological workflow execution events (append-only reader).
 */
export async function listWorkflowEvents(
  ctx: RepoContext,
  { workflowRowId }: { workflowRowId: string },
): Promise<WorkflowEvent[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(workflowEvents)
    .where(eq(workflowEvents.workflowRowId, workflowRowId))
    .orderBy(workflowEvents.occurredAt);
}
