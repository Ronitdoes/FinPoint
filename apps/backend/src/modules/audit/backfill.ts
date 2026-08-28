import type { RepoContext } from "@repo/db/repositories";
import { getExecutor } from "@repo/db/repositories";
import { messages, aiDecisions, policyEvaluations, humanTasks, caseEvents } from "@repo/db/schema";
import { and, eq } from "@repo/db";
import * as repos from "@repo/db/repositories";

export interface BackfillDetail {
  caseId: string;
  eventType: string;
  entityId: string;
}

export interface BackfillResult {
  totalReconstructed: number;
  details: BackfillDetail[];
}

/**
 * Backfill tool mapping orphaned entities without timeline rows into reconstructed case_events (Spec 01 §17, Step 25).
 */
export async function backfillCaseTimelineGaps(
  ctx: RepoContext,
  options: { tenantId?: string } = {},
): Promise<BackfillResult> {
  const executor = getExecutor(ctx);
  const details: BackfillDetail[] = [];

  // 1. Backfill orphaned messages
  const msgConditions = [];
  if (options.tenantId) {
    msgConditions.push(eq(messages.tenantId, options.tenantId));
  }
  const allMessages = await executor
    .select()
    .from(messages)
    .where(msgConditions.length > 0 ? and(...msgConditions) : undefined);

  for (const msg of allMessages) {
    if (!msg.caseId) continue;
    const existingEvents = await repos.listCaseEvents(ctx, {
      tenantId: msg.tenantId,
      caseId: msg.caseId,
      limit: 100,
    });

    const hasEvent = existingEvents.some(
      (e) =>
        (e.eventType === "WHATSAPP_SENT" || e.eventType === "EMAIL_SENT") &&
        (e.payload as any)?.messageId === msg.id,
    );

    if (!hasEvent) {
      const eventType = msg.channel === "WHATSAPP" ? "WHATSAPP_SENT" : "EMAIL_SENT";
      await repos.recordCaseEvent(ctx, {
        tenantId: msg.tenantId,
        caseId: msg.caseId,
        eventType,
        actorType: "SYSTEM",
        description: `[Reconstructed] Message dispatched via ${msg.channel}`,
        payload: {
          messageId: msg.id,
          channel: msg.channel,
          template: msg.templateId,
          status: msg.status,
          reconstructed: true,
        },
        occurredAt: msg.createdAt,
      });

      details.push({
        caseId: msg.caseId,
        eventType,
        entityId: msg.id,
      });
    }
  }

  // 2. Backfill orphaned AI decisions
  const decConditions = [];
  if (options.tenantId) {
    decConditions.push(eq(aiDecisions.tenantId, options.tenantId));
  }
  const allDecisions = await executor
    .select()
    .from(aiDecisions)
    .where(decConditions.length > 0 ? and(...decConditions) : undefined);

  for (const dec of allDecisions) {
    if (!dec.caseId) continue;
    const existingEvents = await repos.listCaseEvents(ctx, {
      tenantId: dec.tenantId,
      caseId: dec.caseId,
      limit: 100,
    });

    const hasEvent = existingEvents.some(
      (e) =>
        e.eventType === "AI_DECISION_CREATED" &&
        (e.payload as any)?.decisionId === dec.id,
    );

    if (!hasEvent) {
      await repos.recordCaseEvent(ctx, {
        tenantId: dec.tenantId,
        caseId: dec.caseId,
        eventType: "AI_DECISION_CREATED",
        actorType: "AI",
        actorId: dec.model,
        description: "[Reconstructed] AI recovery recommendation generated",
        payload: {
          decisionId: dec.id,
          model: dec.model,
          promptVersion: dec.promptVersion,
          confidence: dec.diagnosisConfidence ? Number(dec.diagnosisConfidence) : undefined,
          reconstructed: true,
        },
        occurredAt: dec.createdAt,
      });

      details.push({
        caseId: dec.caseId,
        eventType: "AI_DECISION_CREATED",
        entityId: dec.id,
      });
    }
  }

  // 3. Backfill orphaned Policy evaluations
  const polConditions = [];
  if (options.tenantId) {
    polConditions.push(eq(policyEvaluations.tenantId, options.tenantId));
  }
  const allPolicyEvals = await executor
    .select()
    .from(policyEvaluations)
    .where(polConditions.length > 0 ? and(...polConditions) : undefined);

  for (const pol of allPolicyEvals) {
    if (!pol.caseId) continue;
    const existingEvents = await repos.listCaseEvents(ctx, {
      tenantId: pol.tenantId,
      caseId: pol.caseId,
      limit: 100,
    });

    const hasEvent = existingEvents.some(
      (e) =>
        (e.eventType === "POLICY_ALLOWED" || e.eventType === "POLICY_REJECTED") &&
        (e.payload as any)?.evaluationId === pol.id,
    );

    if (!hasEvent) {
      const eventType = pol.result === "ALLOWED" ? "POLICY_ALLOWED" : "POLICY_REJECTED";
      await repos.recordCaseEvent(ctx, {
        tenantId: pol.tenantId,
        caseId: pol.caseId,
        eventType,
        actorType: "SYSTEM",
        description: `[Reconstructed] Policy engine evaluated decision: ${pol.result}`,
        payload: {
          evaluationId: pol.id,
          verdict: pol.result,
          reconstructed: true,
        },
        occurredAt: pol.evaluatedAt,
      });

      details.push({
        caseId: pol.caseId,
        eventType,
        entityId: pol.id,
      });
    }
  }

  // 4. Backfill orphaned Human Tasks
  const taskConditions = [];
  if (options.tenantId) {
    taskConditions.push(eq(humanTasks.tenantId, options.tenantId));
  }
  const allTasks = await executor
    .select()
    .from(humanTasks)
    .where(taskConditions.length > 0 ? and(...taskConditions) : undefined);

  for (const task of allTasks) {
    if (!task.caseId) continue;
    const existingEvents = await repos.listCaseEvents(ctx, {
      tenantId: task.tenantId,
      caseId: task.caseId,
      limit: 100,
    });

    const hasCreatedEvent = existingEvents.some(
      (e) =>
        e.eventType === "HUMAN_TASK_CREATED" &&
        (e.payload as any)?.taskId === task.id,
    );

    if (!hasCreatedEvent) {
      await repos.recordCaseEvent(ctx, {
        tenantId: task.tenantId,
        caseId: task.caseId,
        eventType: "HUMAN_TASK_CREATED",
        actorType: "SYSTEM",
        description: `[Reconstructed] Escalation task created: ${task.type}`,
        payload: {
          taskId: task.id,
          taskType: task.type,
          status: task.status,
          reconstructed: true,
        },
        occurredAt: task.createdAt,
      });

      details.push({
        caseId: task.caseId,
        eventType: "HUMAN_TASK_CREATED",
        entityId: task.id,
      });
    }
  }

  return {
    totalReconstructed: details.length,
    details,
  };
}

// CLI runner
if ((import.meta as { main?: boolean }).main || process.argv[1]?.endsWith("backfill.ts")) {
  import("@repo/db").then(async ({ db }) => {
    console.log("🛠️ Running timeline gaps backfill...");
    const result = await backfillCaseTimelineGaps({ db });
    console.log(`✅ Backfill completed: ${result.totalReconstructed} orphaned entities reconstructed.`);
    process.exit(0);
  });
}
