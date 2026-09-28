import type { Database } from "@repo/db";
import {
  type HumanTaskType,
  isTerminal,
} from "@repo/domain";
import {
  type RecoveryWorkflowClient,
} from "@repo/orchestration";
import { LiveWorkflowClient } from "../../lib/live-workflow-client";
import {
  getLogger,
  incHumanTasksOpen,
  decHumanTasksOpen,
  recordApprovalLatency,
} from "@repo/observability";
import type { Repositories } from "../../plugins/db";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../../lib/errors";
import type {
  CreateHumanTaskBody,
  HumanTaskActorContext,
  HumanTaskDetailResponse,
  HumanTaskSummaryResponse,
  ListHumanTasksQuery,
} from "./types";

const logger = getLogger({ component: "human-tasks-service" });

const DEFAULT_SLA_DURATIONS_HOURS: Record<HumanTaskType, number> = {
  APPROVAL: 24,
  DISPUTE_REVIEW: 72,
  COMPLIANCE_REVIEW: 48,
  WORKFLOW_FAILURE: 4,
  GENERAL: 24,
};

export class HumanTasksService {
  private readonly workflowClient: RecoveryWorkflowClient;

  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
    workflowClient?: RecoveryWorkflowClient,
  ) {
    // L1: live Temporal dispatch via worker client with DB-row fallback.
    this.workflowClient = workflowClient ?? new LiveWorkflowClient(db);
  }

  /**
   * Helper to calculate default SLA due instant.
   */
  private calculateDefaultSla(type: HumanTaskType): Date {
    const hours = DEFAULT_SLA_DURATIONS_HOURS[type] ?? 24;
    return new Date(Date.now() + hours * 60 * 60 * 1000);
  }

  /**
   * Helper to check if a task is currently overdue.
   */
  private isTaskOverdue(task: {
    status: string;
    slaDueAt: Date | null;
    overdueAt: Date | null;
  }): boolean {
    if (task.overdueAt) {
      return true;
    }
    if (
      ["PENDING", "ASSIGNED"].includes(task.status) &&
      task.slaDueAt &&
      task.slaDueAt.getTime() <= Date.now()
    ) {
      return true;
    }
    return false;
  }

  /**
   * Lists human tasks with filtering and embeds brief case summary (Spec 01 §19, Step 21).
   */
  async listTasks(
    tenantId: string,
    query: ListHumanTasksQuery,
  ): Promise<{ items: HumanTaskSummaryResponse[]; total: number }> {
    const rows = await this.repos.listHumanTasksWithFilters(
      { db: this.db },
      {
        tenantId,
        status: query.status,
        type: query.type,
        assignedTo: query.assigned_to,
        overdue: query.overdue,
        limit: query.limit,
        offset: query.offset,
      },
    );

    // Embed case summary for each task
    const items: HumanTaskSummaryResponse[] = await Promise.all(
      rows.map(async (row) => {
        const caseRow = await this.repos.findCaseById(
          { db: this.db },
          { tenantId, caseId: row.caseId },
        );

        const isOverdue = this.isTaskOverdue(row);

        return {
          id: row.id,
          tenantId: row.tenantId,
          caseId: row.caseId,
          type: row.type,
          title: row.title,
          description: row.description,
          priority: row.priority,
          status: row.status,
          assignedTo: row.assignedTo,
          slaDueAt: row.slaDueAt ? row.slaDueAt.toISOString() : null,
          overdueAt: row.overdueAt ? row.overdueAt.toISOString() : null,
          isOverdue,
          escalationCount: row.escalationCount,
          decidedBy: row.decidedBy,
          decisionNotes: row.decisionNotes,
          decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
          temporalSignalSent: row.temporalSignalSent,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          case: caseRow
            ? {
                id: caseRow.id,
                caseNumber: caseRow.caseNumber,
                customerId: caseRow.customerId,
                status: caseRow.status,
                amountAtRisk: caseRow.amountAtRisk.toString(),
                currency: caseRow.currency,
                riskScore: caseRow.riskScore,
                riskType: caseRow.riskType,
              }
            : undefined,
        };
      }),
    );

    return { items, total: items.length };
  }

  /**
   * Fetches single task detail including full case, decision, and actions context.
   */
  async getTaskDetail(
    tenantId: string,
    taskId: string,
  ): Promise<HumanTaskDetailResponse> {
    const row = await this.repos.findHumanTaskById(
      { db: this.db },
      { tenantId, taskId },
    );

    if (!row) {
      throw new NotFoundError(`Human task '${taskId}' not found`);
    }

    const [caseRow, latestDecision, actions] = await Promise.all([
      this.repos.findCaseById(
        { db: this.db },
        { tenantId, caseId: row.caseId },
      ),
      this.repos.findLatestDecisionForCase(
        { db: this.db },
        { tenantId, caseId: row.caseId },
      ),
      this.repos.listActionsForCase(
        { db: this.db },
        { tenantId, caseId: row.caseId },
      ),
    ]);

    const isOverdue = this.isTaskOverdue(row);

    return {
      id: row.id,
      tenantId: row.tenantId,
      caseId: row.caseId,
      type: row.type,
      title: row.title,
      description: row.description,
      priority: row.priority,
      status: row.status,
      assignedTo: row.assignedTo,
      slaDueAt: row.slaDueAt ? row.slaDueAt.toISOString() : null,
      overdueAt: row.overdueAt ? row.overdueAt.toISOString() : null,
      isOverdue,
      escalationCount: row.escalationCount,
      decidedBy: row.decidedBy,
      decisionNotes: row.decisionNotes,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      temporalSignalSent: row.temporalSignalSent,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      case: caseRow
        ? {
            id: caseRow.id,
            caseNumber: caseRow.caseNumber,
            customerId: caseRow.customerId,
            status: caseRow.status,
            amountAtRisk: caseRow.amountAtRisk.toString(),
            currency: caseRow.currency,
            riskScore: caseRow.riskScore,
            riskType: caseRow.riskType,
          }
        : undefined,
      caseDetail: caseRow ? (caseRow as unknown as Record<string, unknown>) : undefined,
      decisionContext: latestDecision ? (latestDecision as unknown as Record<string, unknown>) : undefined,
      actions: actions ? (actions as unknown as Array<Record<string, unknown>>) : undefined,
    };
  }

  /**
   * Creates a human task (OPERATIONS+).
   */
  async createTask(
    tenantId: string,
    input: CreateHumanTaskBody,
    actor?: HumanTaskActorContext,
  ): Promise<HumanTaskSummaryResponse> {
    const caseRow = await this.repos.findCaseById(
      { db: this.db },
      { tenantId, caseId: input.case_id },
    );

    if (!caseRow) {
      throw new NotFoundError(`Recovery case '${input.case_id}' not found`);
    }

    const slaDueAt = input.sla_due_at
      ? new Date(input.sla_due_at)
      : this.calculateDefaultSla(input.type);

    const created = await this.repos.createHumanTask(
      { db: this.db },
      {
        tenantId,
        caseId: input.case_id,
        type: input.type,
        title: input.title.trim(),
        description: input.description?.trim(),
        priority: input.priority,
        status: "PENDING",
        slaDueAt,
      },
    );

    // Timeline event
    await this.repos.recordCaseEvent(
      { db: this.db },
      {
        tenantId,
        caseId: input.case_id,
        eventType: "HUMAN_TASK_CREATED",
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        description: `Human task created: ${created.title}`,
        payload: {
          taskId: created.id,
          type: created.type,
          priority: created.priority,
          slaDueAt: slaDueAt.toISOString(),
        },
      },
    );

    // Audit log
    await this.repos.recordAuditLog(
      { db: this.db },
      {
        tenantId,
        caseId: input.case_id,
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        event: "HUMAN_TASK_CREATED",
        metadata: {
          taskId: created.id,
          type: created.type,
          title: created.title,
          priority: created.priority,
          slaDueAt: slaDueAt.toISOString(),
        },
      },
    );

    incHumanTasksOpen(created.type);

    logger.info(
      { tenantId, caseId: input.case_id, taskId: created.id, type: created.type },
      "Human task created",
    );

    return {
      id: created.id,
      tenantId: created.tenantId,
      caseId: created.caseId,
      type: created.type,
      title: created.title,
      description: created.description,
      priority: created.priority,
      status: created.status,
      assignedTo: created.assignedTo,
      slaDueAt: created.slaDueAt ? created.slaDueAt.toISOString() : null,
      overdueAt: null,
      isOverdue: false,
      escalationCount: created.escalationCount,
      decidedBy: created.decidedBy,
      decisionNotes: created.decisionNotes,
      decidedAt: null,
      temporalSignalSent: created.temporalSignalSent,
      createdAt: created.createdAt.toISOString(),
      updatedAt: created.updatedAt.toISOString(),
    };
  }

  /**
   * Approves a human task (OPERATIONS+).
   * Strict security: Requires authenticated interactive user session (never API key).
   */
  async approveTask(
    tenantId: string,
    taskId: string,
    actor: HumanTaskActorContext,
    notes?: string,
  ): Promise<{ status: "APPROVED"; taskId: string }> {
    // 1. Session user security enforcement (ADR-012, Step 21)
    if (actor.actorType !== "USER" || !actor.userId) {
      throw new ForbiddenError(
        "Task approval requires an authenticated interactive user session",
      );
    }

    const task = await this.repos.findHumanTaskById(
      { db: this.db },
      { tenantId, taskId },
    );

    if (!task) {
      throw new NotFoundError(`Human task '${taskId}' not found`);
    }

    if (["APPROVED", "REJECTED", "RESOLVED", "CANCELLED"].includes(task.status)) {
      throw new ConflictError(
        `Cannot approve task '${taskId}' because it is already in terminal status '${task.status}'`,
        "TASK_ALREADY_RESOLVED",
      );
    }

    // 2. Atomic guarded update
    const updated = await this.repos.decideHumanTask(
      { db: this.db },
      {
        tenantId,
        taskId,
        status: "APPROVED",
        decidedBy: actor.userId,
        decisionNotes: notes?.trim(),
      },
    );

    if (!updated) {
      throw new ConflictError(
        `Task '${taskId}' was already resolved concurrently`,
        "TASK_ALREADY_RESOLVED",
      );
    }

    // 3. Side effects for APPROVAL type tasks tied to case:
    // - Transition case from ESCALATED -> IN_PROGRESS
    // - Transition pending actions APPROVAL_REQUIRED -> APPROVED
    const caseRow = await this.repos.findCaseById(
      { db: this.db },
      { tenantId, caseId: task.caseId },
    );

    if (caseRow && caseRow.status === "ESCALATED") {
      await this.repos.transitionCaseStatus(
        { db: this.db },
        {
          tenantId,
          caseId: task.caseId,
          from: ["ESCALATED"],
          to: "IN_PROGRESS",
          reason: notes?.trim() || "HUMAN_APPROVAL_GRANTED",
        },
      );
    }

    // Update pending action rows
    await this.repos.updateActionsStatusForCase(
      { db: this.db },
      {
        tenantId,
        caseId: task.caseId,
        fromStatuses: ["APPROVAL_REQUIRED"],
        toStatus: "APPROVED",
      },
    );

    // 4. Signal Temporal workflow
    const decidedAtIso = new Date().toISOString();
    await this.workflowClient.signalCase({
      tenantId,
      caseId: task.caseId,
      signal: "human-decision",
      payload: {
        taskId: task.id,
        approved: true,
        notes: notes?.trim(),
        decidedBy: actor.userId,
        decidedAt: decidedAtIso,
      },
      db: this.db,
    });

    await this.repos.markSignalSent(
      { db: this.db },
      { tenantId, taskId: task.id },
    );

    // 5. Record timeline event
    await this.repos.recordCaseEvent(
      { db: this.db },
      {
        tenantId,
        caseId: task.caseId,
        eventType: "HUMAN_DECISION_RECORDED",
        actorType: "USER",
        actorId: actor.userId,
        description: `Human task approved: ${task.title}${notes ? ` (${notes.trim()})` : ""}`,
        payload: {
          taskId: task.id,
          decision: "APPROVED",
          notes: notes?.trim(),
          decidedBy: actor.userId,
        },
      },
    );

    // 6. Record audit log
    await this.repos.recordAuditLog(
      { db: this.db },
      {
        tenantId,
        caseId: task.caseId,
        actorType: "USER",
        actorId: actor.userId,
        event: "HUMAN_TASK_APPROVED",
        metadata: {
          taskId: task.id,
          notes: notes?.trim(),
          fromStatus: task.status,
          toStatus: "APPROVED",
        },
      },
    );

    // 7. Observability metrics
    const latencyMs = Math.max(0, Date.now() - task.createdAt.getTime());
    recordApprovalLatency(task.type, "APPROVED", latencyMs);
    decHumanTasksOpen(task.type);

    logger.info(
      { tenantId, taskId: task.id, caseId: task.caseId, decidedBy: actor.userId },
      "Human task approved",
    );

    return { status: "APPROVED", taskId: task.id };
  }

  /**
   * Rejects a human task (OPERATIONS+).
   * Strict security: Requires authenticated interactive user session and mandatory notes.
   */
  async rejectTask(
    tenantId: string,
    taskId: string,
    actor: HumanTaskActorContext,
    notes: string,
  ): Promise<{ status: "REJECTED"; taskId: string }> {
    // 1. Session user security enforcement
    if (actor.actorType !== "USER" || !actor.userId) {
      throw new ForbiddenError(
        "Task rejection requires an authenticated interactive user session",
      );
    }

    // 2. Mandatory rejection notes validation (Spec 01 §19, Step 21)
    if (!notes || typeof notes !== "string" || notes.trim().length === 0) {
      throw new ValidationError("Notes are mandatory when rejecting a human task", {
        field: "notes",
      });
    }

    const task = await this.repos.findHumanTaskById(
      { db: this.db },
      { tenantId, taskId },
    );

    if (!task) {
      throw new NotFoundError(`Human task '${taskId}' not found`);
    }

    if (["APPROVED", "REJECTED", "RESOLVED", "CANCELLED"].includes(task.status)) {
      throw new ConflictError(
        `Cannot reject task '${taskId}' because it is already in terminal status '${task.status}'`,
        "TASK_ALREADY_RESOLVED",
      );
    }

    // 3. Atomic guarded update
    const updated = await this.repos.decideHumanTask(
      { db: this.db },
      {
        tenantId,
        taskId,
        status: "REJECTED",
        decidedBy: actor.userId,
        decisionNotes: notes.trim(),
      },
    );

    if (!updated) {
      throw new ConflictError(
        `Task '${taskId}' was already resolved concurrently`,
        "TASK_ALREADY_RESOLVED",
      );
    }

    // 4. Side effects: Cancel pending actions with reason HUMAN_REJECTED
    await this.repos.updateActionsStatusForCase(
      { db: this.db },
      {
        tenantId,
        caseId: task.caseId,
        fromStatuses: ["APPROVAL_REQUIRED", "PROPOSED"],
        toStatus: "CANCELLED",
        reason: "HUMAN_REJECTED",
      },
    );

    // 5. Signal Temporal workflow
    const decidedAtIso = new Date().toISOString();
    await this.workflowClient.signalCase({
      tenantId,
      caseId: task.caseId,
      signal: "human-decision",
      payload: {
        taskId: task.id,
        approved: false,
        notes: notes.trim(),
        decidedBy: actor.userId,
        decidedAt: decidedAtIso,
      },
      db: this.db,
    });

    await this.repos.markSignalSent(
      { db: this.db },
      { tenantId, taskId: task.id },
    );

    // 6. Record timeline event
    await this.repos.recordCaseEvent(
      { db: this.db },
      {
        tenantId,
        caseId: task.caseId,
        eventType: "HUMAN_DECISION_RECORDED",
        actorType: "USER",
        actorId: actor.userId,
        description: `Human task rejected: ${notes.trim()}`,
        payload: {
          taskId: task.id,
          decision: "REJECTED",
          notes: notes.trim(),
          decidedBy: actor.userId,
        },
      },
    );

    // 7. Record audit log
    await this.repos.recordAuditLog(
      { db: this.db },
      {
        tenantId,
        caseId: task.caseId,
        actorType: "USER",
        actorId: actor.userId,
        event: "HUMAN_TASK_REJECTED",
        metadata: {
          taskId: task.id,
          notes: notes.trim(),
          fromStatus: task.status,
          toStatus: "REJECTED",
        },
      },
    );

    // 8. Observability metrics
    const latencyMs = Math.max(0, Date.now() - task.createdAt.getTime());
    recordApprovalLatency(task.type, "REJECTED", latencyMs);
    decHumanTasksOpen(task.type);

    logger.info(
      { tenantId, taskId: task.id, caseId: task.caseId, decidedBy: actor.userId },
      "Human task rejected",
    );

    return { status: "REJECTED", taskId: task.id };
  }

  /**
   * Assigns a human task to an agent (FINANCE+).
   */
  async assignTask(
    tenantId: string,
    taskId: string,
    assigneeUserId: string | null,
    actor?: HumanTaskActorContext,
  ): Promise<HumanTaskSummaryResponse> {
    const task = await this.repos.findHumanTaskById(
      { db: this.db },
      { tenantId, taskId },
    );

    if (!task) {
      throw new NotFoundError(`Human task '${taskId}' not found`);
    }

    if (["APPROVED", "REJECTED", "RESOLVED", "CANCELLED"].includes(task.status)) {
      throw new ConflictError(
        `Cannot assign task '${taskId}' because it is in terminal status '${task.status}'`,
        "TASK_TERMINAL",
      );
    }

    const updated = await this.repos.assignHumanTask(
      { db: this.db },
      {
        tenantId,
        taskId,
        assignedTo: assigneeUserId,
      },
    );

    if (!updated) {
      throw new ConflictError(
        `Failed to assign task '${taskId}' due to concurrent update`,
        "ILLEGAL_TRANSITION",
      );
    }

    // Audit log
    await this.repos.recordAuditLog(
      { db: this.db },
      {
        tenantId,
        caseId: task.caseId,
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        event: "HUMAN_TASK_ASSIGNED",
        metadata: {
          taskId: task.id,
          assignedTo: assigneeUserId,
          previousAssignedTo: task.assignedTo,
        },
      },
    );

    logger.info(
      { tenantId, taskId: task.id, assignedTo: assigneeUserId },
      "Human task assigned",
    );

    return {
      id: updated.id,
      tenantId: updated.tenantId,
      caseId: updated.caseId,
      type: updated.type,
      title: updated.title,
      description: updated.description,
      priority: updated.priority,
      status: updated.status,
      assignedTo: updated.assignedTo,
      slaDueAt: updated.slaDueAt ? updated.slaDueAt.toISOString() : null,
      overdueAt: updated.overdueAt ? updated.overdueAt.toISOString() : null,
      isOverdue: this.isTaskOverdue(updated),
      escalationCount: updated.escalationCount,
      decidedBy: updated.decidedBy,
      decisionNotes: updated.decisionNotes,
      decidedAt: updated.decidedAt ? updated.decidedAt.toISOString() : null,
      temporalSignalSent: updated.temporalSignalSent,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Cancels a human task (FINANCE+).
   */
  async cancelTask(
    tenantId: string,
    taskId: string,
    reason?: string,
    actor?: HumanTaskActorContext,
  ): Promise<{ status: "CANCELLED"; taskId: string }> {
    const task = await this.repos.findHumanTaskById(
      { db: this.db },
      { tenantId, taskId },
    );

    if (!task) {
      throw new NotFoundError(`Human task '${taskId}' not found`);
    }

    if (["APPROVED", "REJECTED", "RESOLVED", "CANCELLED"].includes(task.status)) {
      throw new ConflictError(
        `Cannot cancel task '${taskId}' because it is in terminal status '${task.status}'`,
        "TASK_TERMINAL",
      );
    }

    const updated = await this.repos.cancelHumanTask(
      { db: this.db },
      {
        tenantId,
        taskId,
        reason: reason?.trim(),
      },
    );

    if (!updated) {
      throw new ConflictError(
        `Failed to cancel task '${taskId}' due to concurrent update`,
        "ILLEGAL_TRANSITION",
      );
    }

    // Audit log
    await this.repos.recordAuditLog(
      { db: this.db },
      {
        tenantId,
        caseId: task.caseId,
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        event: "HUMAN_TASK_CANCELLED",
        metadata: {
          taskId: task.id,
          reason: reason?.trim(),
        },
      },
    );

    decHumanTasksOpen(task.type);

    logger.info({ tenantId, taskId: task.id, reason }, "Human task cancelled");

    return { status: "CANCELLED", taskId: task.id };
  }
}
