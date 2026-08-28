import {
  transitionCaseStatus,
  findWorkflowByCaseId,
  updateWorkflowStatus,
  recordCaseEvent,
} from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
} from "../framework";

export interface StopCaseWithReasonInput extends ActivityContext {
  stopReason: string;
  notes?: string;
}

export interface StopCaseWithReasonResult {
  success: boolean;
  status: "STOPPED";
  stopReason: string;
}

/**
 * Activity: stopCaseWithReason
 * Terminates recovery case processing with an explicit stop reason and updates workflow state.
 */
export async function stopCaseWithReason(
  input: StopCaseWithReasonInput,
): Promise<StopCaseWithReasonResult> {
  return await withActivityContext("stopCaseWithReason", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const now = new Date();

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
          to: "STOPPED",
          reason: input.stopReason,
          closedAt: now,
        },
      );

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
            status: "COMPLETED",
            closedAt: now,
          },
        );
      }

      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: "CASE_STOPPED",
          actorType: "SYSTEM",
          description: `Case stopped: ${input.stopReason}`,
          payload: {
            stopReason: input.stopReason,
            notes: input.notes,
          },
        },
      );

      return {
        success: true,
        status: "STOPPED",
        stopReason: input.stopReason,
      };
    });
  });
}
