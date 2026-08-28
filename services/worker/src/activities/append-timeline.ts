import {
  recordCaseEvent,
} from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
} from "../framework";

export interface AppendTimelineInput extends ActivityContext {
  type: string;
  title?: string;
  description?: string;
  actorType?: "SYSTEM" | "HUMAN" | "AI" | "CUSTOMER" | "WORKFLOW" | "PROVIDER";
  actorId?: string;
  payload?: Record<string, unknown>;
}

export interface AppendTimelineResult {
  eventId: number;
  occurredAt: string;
}

/**
 * Activity: appendTimeline
 * Appends an immutable event row to the recovery case timeline ledger.
 */
export async function appendTimeline(
  input: AppendTimelineInput,
): Promise<AppendTimelineResult> {
  return await withActivityContext("appendTimeline", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      let actorType: "SYSTEM" | "AI" | "USER" | "WORKFLOW" | "PROVIDER" = "SYSTEM";
      if (input.actorType === "HUMAN" || input.actorType === "CUSTOMER") {
        actorType = "USER";
      } else if (input.actorType === "AI") {
        actorType = "AI";
      } else if (input.actorType === "WORKFLOW") {
        actorType = "WORKFLOW";
      } else if (input.actorType === "PROVIDER") {
        actorType = "PROVIDER";
      }

      const event = await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: input.type ?? "WORKFLOW_STEP",
          actorType,
          actorId: input.actorId,
          description: input.description ?? input.title,
          payload: input.payload ?? {},
        },
      );

      return {
        eventId: event.id,
        occurredAt: event.occurredAt.toISOString(),
      };
    });
  });
}
