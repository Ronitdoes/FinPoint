import {
  transitionCaseStatus,
  recordCaseEvent,
} from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
} from "../framework";

export interface MarkCaseWaitingInput extends ActivityContext {
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface MarkCaseWaitingResult {
  success: boolean;
  status: "WAITING";
}

/**
 * Activity: markCaseWaiting
 * Sets the recovery case status to WAITING with state machine validation and timeline logging.
 */
export async function markCaseWaiting(
  input: MarkCaseWaitingInput,
): Promise<MarkCaseWaitingResult> {
  return await withActivityContext("markCaseWaiting", input, async () => {
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
          to: "WAITING",
          reason: input.reason,
        },
      );

      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: "CASE_WAITING",
          actorType: "SYSTEM",
          description: `Case entered WAITING: ${input.reason}`,
          payload: input.metadata ?? { reason: input.reason },
        },
      );

      return {
        success: true,
        status: "WAITING",
      };
    });
  });
}
