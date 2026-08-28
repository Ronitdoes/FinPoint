import {
  transitionCaseStatus,
  createHumanTask,
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
}

/**
 * Activity: escalateWorkflowFailure
 * Handles unexpected/fatal workflow failures: transitions case to ESCALATED,
 * creates an urgent human review task, records timeline event, and updates workflow status to FAILED.
 */
export async function escalateWorkflowFailure(
  input: EscalateWorkflowFailureInput,
): Promise<EscalateWorkflowFailureResult> {
  return await withActivityContext("escalateWorkflowFailure", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const now = new Date();

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

      // 2. Create emergency human task
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
        },
      );

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
          description: `Workflow escalated due to technical failure: ${input.errorName}`,
          payload: {
            taskId: task.id,
            errorName: input.errorName,
            errorMessage: input.errorMessage,
            failedStep: input.failedStep,
          },
        },
      );

      return {
        success: true,
        taskId: task.id,
      };
    });
  });
}
