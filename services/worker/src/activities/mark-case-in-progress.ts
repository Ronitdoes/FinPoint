import {
  transitionCaseStatus,
  recordCaseEvent,
} from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
} from "../framework";

export interface MarkCaseInProgressInput extends ActivityContext {
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface MarkCaseInProgressResult {
  success: boolean;
  status: "IN_PROGRESS";
}

/**
 * Activity: markCaseInProgress
 * Sets the recovery case status to IN_PROGRESS with state machine validation and timeline logging.
 */
export async function markCaseInProgress(
  input: MarkCaseInProgressInput,
): Promise<MarkCaseInProgressResult> {
  return await withActivityContext("markCaseInProgress", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
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
          to: "IN_PROGRESS",
          reason: input.reason,
        },
      );

      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: "CASE_IN_PROGRESS",
          actorType: "SYSTEM",
          description: `Case marked IN_PROGRESS${input.reason ? `: ${input.reason}` : ""}`,
          payload: input.metadata ?? {},
        },
      );

      return {
        success: true,
        status: "IN_PROGRESS",
      };
    });
  });
}
