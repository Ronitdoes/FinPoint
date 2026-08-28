import {
  transitionCaseStatus,
  createHumanTask,
  findRecentHumanTaskForCase,
  incrementEscalationCount,
  updateWorkflowStatus,
  findWorkflowByCaseId,
  recordCaseEvent,
} from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
} from "../framework";

export interface EscalateWorkflowFailureInput extends ActivityContext {
  errorName: string;
  errorMessage: string;
  errorStack?: string;
  failedStep?: string;
}

export interface EscalateWorkflowFailureResult {
  success: boolean;
  taskId: string;
  isDeduplicated?: boolean;
}

/**
 * Activity: escalateWorkflowFailure
 * Handles unexpected/fatal workflow failures: transitions case to ESCALATED,
 * creates an urgent human review task (with 1h deduplication guard against burst storms),
 * records timeline event, and updates workflow status to FAILED.
 */
export async function escalateWorkflowFailure(
  input: EscalateWorkflowFailureInput,
): Promise<EscalateWorkflowFailureResult> {
  return await withActivityContext("escalateWorkflowFailure", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      // 1. Transition case to ESCALATED
      await transitionCaseStatus(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          from: [
            "DETECTED",
            "QUALIFIED",
            "DECISION_PENDING",
            "POLICY_REVIEW",
            "IN_PROGRESS",
            "WAITING",
          ],
          to: "ESCALATED",
          reason: "TECHNICAL_FAILURE",
        },
      );

      // 2. Re-escalation deduplication guard (Spec 01 §19, Step 21 Requirement 6)
      const existingTask = await findRecentHumanTaskForCase(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          type: "WORKFLOW_FAILURE",
          since: oneHourAgo,
        },
      );

      let taskId: string;
      let isDeduplicated = false;

      if (existingTask) {
        // Increment escalation count on existing active burst task
        await incrementEscalationCount(
          { db, tx },
          { tenantId: input.tenantId, taskId: existingTask.id },
        );
        taskId = existingTask.id;
        isDeduplicated = true;
      } else {
        // Create emergency human task with 4h SLA
        const task = await createHumanTask(
          { db, tx },
          {
            tenantId: input.tenantId,
            caseId: input.caseId,
            type: "WORKFLOW_FAILURE",
            title: `Workflow execution failed: ${input.errorName}`,
            description: `Failed step: ${input.failedStep ?? "unknown"}\nError: ${input.errorMessage}\n${input.errorStack ?? ""}`,
            priority: "URGENT",
            status: "PENDING",
            slaDueAt: new Date(now.getTime() + 4 * 60 * 60 * 1000), // 4h SLA
            escalationCount: 1,
          },
        );
        taskId = task.id;
      }

      // 3. Mark workflow row as FAILED
      const workflow = await findWorkflowByCaseId(
        { db, tx },
        { tenantId: input.tenantId, caseId: input.caseId },
      );

      if (workflow) {
        await updateWorkflowStatus(
          { db, tx },
          {
            tenantId: input.tenantId,
            workflowId: workflow.id,
            status: "FAILED",
            closedAt: now,
          },
        );
      }

      // 4. Record timeline event
      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: "CASE_ESCALATED",
          actorType: "SYSTEM",
          description: isDeduplicated
            ? `Workflow repeated failure (deduplicated to existing task): ${input.errorName}`
            : `Workflow escalated due to technical failure: ${input.errorName}`,
          payload: {
            taskId,
            errorName: input.errorName,
            errorMessage: input.errorMessage,
            failedStep: input.failedStep,
            isDeduplicated,
          },
        },
      );

      return {
        success: true,
        taskId,
        isDeduplicated,
      };
    });
  });
}
