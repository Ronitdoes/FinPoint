import {
  createHumanTask as dbCreateHumanTask,
  recordCaseEvent,
} from "@repo/db";
import type { HumanTaskType } from "@repo/domain";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
} from "../framework";

export interface CreateHumanTaskActivityInput extends ActivityContext {
  taskType: HumanTaskType | string;
  title: string;
  description?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  slaDueAt?: string;
}

export interface CreateHumanTaskActivityResult {
  taskId: string;
  status: string;
  createdAt: string;
}

/**
 * Activity: createHumanTask
 * Creates a human escalation task row in the database and records a timeline event.
 */
export async function createHumanTask(
  input: CreateHumanTaskActivityInput,
): Promise<CreateHumanTaskActivityResult> {
  return await withActivityContext("createHumanTask", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const task = await dbCreateHumanTask(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          type: (input.taskType as HumanTaskType) ?? "APPROVAL",
          title: input.title,
          description: input.description,
          priority: input.priority ?? "MEDIUM",
          status: "PENDING",
          slaDueAt: input.slaDueAt ? new Date(input.slaDueAt) : undefined,
        },
      );

      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: "HUMAN_TASK_CREATED",
          actorType: "SYSTEM",
          description: `Human task created: ${input.title}`,
          payload: {
            taskId: task.id,
            type: input.taskType,
            priority: input.priority ?? "MEDIUM",
          },
        },
      );

      return {
        taskId: task.id,
        status: task.status,
        createdAt: task.createdAt.toISOString(),
      };
    });
  });
}
