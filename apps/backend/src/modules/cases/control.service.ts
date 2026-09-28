import type { Database } from "@repo/db";
import { isTerminal } from "@repo/domain";
import {
  type RecoveryWorkflowClient,
} from "@repo/orchestration";
import { LiveWorkflowClient } from "../../lib/live-workflow-client";
import { getLogger } from "@repo/observability";
import type { Repositories } from "../../plugins/db";
import {
  CaseNotFoundError,
  ConflictError,
  ValidationError,
} from "../../lib/errors";
import type { CaseActorContext } from "./case.types";

const logger = getLogger({ component: "case-control-service" });

export class CaseControlService {
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
   * Pauses an IN_PROGRESS case -> WAITING status (Spec 02 §13, Step 17).
   * Authorized for OPERATIONS, FINANCE, ADMIN.
   */
  async pauseCase(
    tenantId: string,
    caseId: string,
    actor?: CaseActorContext,
  ): Promise<{ status: "WAITING" }> {
    const caseRow = await this.repos.findCaseById(
      { db: this.db },
      { tenantId, caseId },
    );

    if (!caseRow) {
      throw new CaseNotFoundError(`Recovery case '${caseId}' not found`);
    }

    if (isTerminal(caseRow.status)) {
      throw new ConflictError(
        `Cannot pause case '${caseId}' because it is in terminal status '${caseRow.status}'`,
        "CASE_TERMINAL",
      );
    }

    const updated = await this.repos.transitionCaseStatus(
      { db: this.db },
      {
        tenantId,
        caseId,
        from: ["IN_PROGRESS"],
        to: "WAITING",
        reason: "MANUAL_PAUSE",
      },
    );

    if (!updated) {
      throw new ConflictError(
        `Illegal transition: cannot pause case in status '${caseRow.status}'`,
        "ILLEGAL_TRANSITION",
      );
    }

    // Signal workflow
    await this.workflowClient.signalCase({
      tenantId,
      caseId,
      signal: "pause",
      payload: { actorId: actor?.userId },
      db: this.db,
    });

    // Timeline event
    await this.repos.recordCaseEvent(
      { db: this.db },
      {
        tenantId,
        caseId,
        eventType: "CASE_PAUSED",
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        description: "Recovery case paused by operator",
      },
    );

    // Audit log
    await this.repos.recordAuditLog(
      { db: this.db },
      {
        tenantId,
        caseId,
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        event: "CASE_PAUSED",
        metadata: { fromStatus: caseRow.status, toStatus: "WAITING" },
      },
    );

    logger.info({ tenantId, caseId, actor: actor?.userId }, "Case paused");
    return { status: "WAITING" };
  }

  /**
   * Resumes a WAITING case -> IN_PROGRESS status (Spec 02 §13, Step 17).
   * Authorized for OPERATIONS, FINANCE, ADMIN.
   */
  async resumeCase(
    tenantId: string,
    caseId: string,
    actor?: CaseActorContext,
  ): Promise<{ status: "IN_PROGRESS" }> {
    const caseRow = await this.repos.findCaseById(
      { db: this.db },
      { tenantId, caseId },
    );

    if (!caseRow) {
      throw new CaseNotFoundError(`Recovery case '${caseId}' not found`);
    }

    if (isTerminal(caseRow.status)) {
      throw new ConflictError(
        `Cannot resume case '${caseId}' because it is in terminal status '${caseRow.status}'`,
        "CASE_TERMINAL",
      );
    }

    const updated = await this.repos.transitionCaseStatus(
      { db: this.db },
      {
        tenantId,
        caseId,
        from: ["WAITING"],
        to: "IN_PROGRESS",
        reason: "MANUAL_RESUME",
      },
    );

    if (!updated) {
      throw new ConflictError(
        `Illegal transition: cannot resume case in status '${caseRow.status}'`,
        "ILLEGAL_TRANSITION",
      );
    }

    // Signal workflow
    await this.workflowClient.signalCase({
      tenantId,
      caseId,
      signal: "resume",
      payload: { actorId: actor?.userId },
      db: this.db,
    });

    // Timeline event
    await this.repos.recordCaseEvent(
      { db: this.db },
      {
        tenantId,
        caseId,
        eventType: "CASE_RESUMED",
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        description: "Recovery case resumed by operator",
      },
    );

    // Audit log
    await this.repos.recordAuditLog(
      { db: this.db },
      {
        tenantId,
        caseId,
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        event: "CASE_RESUMED",
        metadata: { fromStatus: caseRow.status, toStatus: "IN_PROGRESS" },
      },
    );

    logger.info({ tenantId, caseId, actor: actor?.userId }, "Case resumed");
    return { status: "IN_PROGRESS" };
  }

  /**
   * Escalates a live case to ESCALATED status and creates a human task (Spec 02 §13, Step 17).
   * Authorized for SUPPORT, OPERATIONS, FINANCE, ADMIN.
   */
  async escalateCase(
    tenantId: string,
    caseId: string,
    actor?: CaseActorContext,
    notes?: string,
  ): Promise<{ status: "ESCALATED"; taskId: string }> {
    const caseRow = await this.repos.findCaseById(
      { db: this.db },
      { tenantId, caseId },
    );

    if (!caseRow) {
      throw new CaseNotFoundError(`Recovery case '${caseId}' not found`);
    }

    if (isTerminal(caseRow.status)) {
      throw new ConflictError(
        `Cannot escalate case '${caseId}' because it is in terminal status '${caseRow.status}'`,
        "CASE_TERMINAL",
      );
    }

    const updated = await this.repos.transitionCaseStatus(
      { db: this.db },
      {
        tenantId,
        caseId,
        from: [
          "DETECTED",
          "QUALIFIED",
          "DECISION_PENDING",
          "POLICY_REVIEW",
          "IN_PROGRESS",
          "WAITING",
        ],
        to: "ESCALATED",
        reason: notes || "MANUAL_ESCALATION",
      },
    );

    if (!updated) {
      throw new ConflictError(
        `Illegal transition: cannot escalate case in status '${caseRow.status}'`,
        "ILLEGAL_TRANSITION",
      );
    }

    // Create GENERAL Human Task
    const task = await this.repos.createHumanTask(
      { db: this.db },
      {
        tenantId,
        caseId,
        type: "GENERAL",
        title: "Manual Case Escalation",
        description: notes || "Case manually escalated for agent intervention",
        priority: "HIGH",
        status: "PENDING",
        slaDueAt: new Date(Date.now() + 12 * 60 * 60 * 1000), // 12h SLA
      },
    );

    // Timeline events
    await this.repos.recordCaseEvent(
      { db: this.db },
      {
        tenantId,
        caseId,
        eventType: "HUMAN_TASK_CREATED",
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        description: `Human task created: ${task.title} (ID: ${task.id})`,
        payload: { taskId: task.id, type: task.type, priority: task.priority },
      },
    );

    await this.repos.recordCaseEvent(
      { db: this.db },
      {
        tenantId,
        caseId,
        eventType: "CASE_ESCALATED",
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        description: `Case escalated: ${notes || "Manual escalation"}`,
        payload: { taskId: task.id, reason: notes },
      },
    );

    // Audit log
    await this.repos.recordAuditLog(
      { db: this.db },
      {
        tenantId,
        caseId,
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        event: "CASE_ESCALATED",
        metadata: {
          taskId: task.id,
          reason: notes,
          fromStatus: caseRow.status,
          toStatus: "ESCALATED",
        },
      },
    );

    logger.info(
      { tenantId, caseId, taskId: task.id, actor: actor?.userId },
      "Case escalated and task created",
    );
    return { status: "ESCALATED", taskId: task.id };
  }

  /**
   * Stops a live recovery case (Spec 02 §13, Step 17).
   * Reason is MANDATORY.
   * Authorized for FINANCE, ADMIN (due to financial impact).
   */
  async stopCase(
    tenantId: string,
    caseId: string,
    reason: string,
    actor?: CaseActorContext,
  ): Promise<{ status: "STOPPED" }> {
    if (!reason || typeof reason !== "string" || reason.trim().length === 0) {
      throw new ValidationError("reason is required to stop a recovery case", {
        field: "reason",
      });
    }

    const caseRow = await this.repos.findCaseById(
      { db: this.db },
      { tenantId, caseId },
    );

    if (!caseRow) {
      throw new CaseNotFoundError(`Recovery case '${caseId}' not found`);
    }

    if (isTerminal(caseRow.status)) {
      throw new ConflictError(
        `Cannot stop case '${caseId}' because it is in terminal status '${caseRow.status}'`,
        "CASE_TERMINAL",
      );
    }

    const updated = await this.repos.transitionCaseStatus(
      { db: this.db },
      {
        tenantId,
        caseId,
        from: [
          "DETECTED",
          "QUALIFIED",
          "DECISION_PENDING",
          "POLICY_REVIEW",
          "IN_PROGRESS",
          "WAITING",
          "ESCALATED",
        ],
        to: "STOPPED",
        reason: reason.trim(),
      },
    );

    if (!updated) {
      throw new ConflictError(
        `Illegal transition: cannot stop case in status '${caseRow.status}'`,
        "ILLEGAL_TRANSITION",
      );
    }

    // Cancel workflow
    await this.workflowClient.cancelWorkflow({
      tenantId,
      caseId,
      reason: reason.trim(),
      db: this.db,
    });

    // Timeline event
    await this.repos.recordCaseEvent(
      { db: this.db },
      {
        tenantId,
        caseId,
        eventType: "CASE_STOPPED",
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        description: `Recovery case stopped: ${reason.trim()}`,
        payload: { reason: reason.trim() },
      },
    );

    // Audit log
    await this.repos.recordAuditLog(
      { db: this.db },
      {
        tenantId,
        caseId,
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        event: "CASE_STOPPED",
        metadata: {
          reason: reason.trim(),
          fromStatus: caseRow.status,
          toStatus: "STOPPED",
        },
      },
    );

    logger.info(
      { tenantId, caseId, reason, actor: actor?.userId },
      "Case manually stopped",
    );
    return { status: "STOPPED" };
  }

  /**
   * Assigns a recovery case to an agent.
   */
  async assignCase(
    tenantId: string,
    caseId: string,
    assignedTo: string | null,
    actor?: CaseActorContext,
  ) {
    const caseRow = await this.repos.findCaseById(
      { db: this.db },
      { tenantId, caseId },
    );

    if (!caseRow) {
      throw new CaseNotFoundError(`Recovery case '${caseId}' not found`);
    }

    const updated = await this.repos.assignCase(
      { db: this.db },
      { tenantId, caseId, assignedTo },
    );

    await this.repos.recordAuditLog(
      { db: this.db },
      {
        tenantId,
        caseId,
        actorType: actor?.actorType ?? "USER",
        actorId: actor?.userId,
        event: "CASE_ASSIGNED",
        metadata: { assignedTo, previousAssignedTo: caseRow.assignedTo },
      },
    );

    return updated;
  }
}
