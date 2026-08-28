import {
  findHumanTaskById,
} from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
  createNonRetryableFailure,
} from "../framework";

export interface WaitForHumanDecisionInput extends ActivityContext {
  taskId: string;
}

export interface HumanDecisionResult {
  taskId: string;
  status: string;
  approved: boolean;
  decidedBy?: string;
  decisionNotes?: string;
  decidedAt?: string;
}

/**
 * Activity: waitForHumanDecision
 * Reads the latest recorded status and decision notes for a human task.
 */
export async function waitForHumanDecision(
  input: WaitForHumanDecisionInput,
): Promise<HumanDecisionResult> {
  return await withActivityContext("waitForHumanDecision", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const task = await findHumanTaskById(
        { db, tx },
        { tenantId: input.tenantId, taskId: input.taskId },
      );

      if (!task) {
        throw createNonRetryableFailure(
          `Human task '${input.taskId}' not found`,
          "ENTITY_NOT_FOUND",
        );
      }

      const approved = task.status === "APPROVED" || task.status === "RESOLVED";

      return {
        taskId: task.id,
        status: task.status,
        approved,
        decidedBy: task.decidedBy ?? undefined,
        decisionNotes: task.decisionNotes ?? undefined,
        decidedAt: task.decidedAt?.toISOString(),
      };
    });
  });
}
