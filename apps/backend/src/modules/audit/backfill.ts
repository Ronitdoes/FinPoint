import type { RepoContext } from "@repo/db/repositories";
import { getExecutor } from "@repo/db/repositories";
import { messages, aiDecisions, policyEvaluations, humanTasks, caseEvents, paymentAttempts, recoveryCases } from "@repo/db/schema";
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

  // 5. Backfill orphaned Payment Attempts -> PAYMENT_RETRY_* (audit fix).
  // payment_attempts has no caseId; resolve via payments.id -> recovery_cases.source_entity_id
  // (UUID match, sourceEntityType-agnostic to tolerate PAYMENT/payment casing drift).
  const attemptConditions = [];
  if (options.tenantId) {
    attemptConditions.push(eq(paymentAttempts.tenantId, options.tenantId));
  }
  const allAttempts = await executor
    .select()
    .from(paymentAttempts)
    .where(attemptConditions.length > 0 ? and(...attemptConditions) : undefined);

  const RETRY_EVENT_TYPES = new Set([
    "PAYMENT_RETRY_STARTED",
    "PAYMENT_RETRY_ATTEMPTED",
    "PAYMENT_SUCCEEDED",
  ]);

  for (const attempt of allAttempts) {
    const payment = await repos.findPaymentById(ctx, {
      tenantId: attempt.tenantId,
      paymentId: attempt.paymentId,
    });
    if (!payment) continue;

    const linkedCases = await executor
      .select({ id: recoveryCases.id, tenantId: recoveryCases.tenantId })
      .from(recoveryCases)
      .where(
        and(
          eq(recoveryCases.tenantId, attempt.tenantId),
          eq(recoveryCases.sourceEntityId, payment.id),
        ),
      );

    for (const linkedCase of linkedCases) {
      const existingEvents = await repos.listCaseEvents(ctx, {
        tenantId: linkedCase.tenantId,
        caseId: linkedCase.id,
        limit: 100,
      });

      const hasEvent = existingEvents.some(
        (e) =>
          RETRY_EVENT_TYPES.has(e.eventType) &&
          (e.payload as any)?.attemptId === attempt.id,
      );
      if (hasEvent) continue;

      const isSuccess = attempt.status === "SUCCEEDED";
      const eventType = isSuccess ? "PAYMENT_SUCCEEDED" : "PAYMENT_RETRY_STARTED";
      await repos.recordCaseEvent(ctx, {
        tenantId: linkedCase.tenantId,
        caseId: linkedCase.id,
        eventType,
        actorType: isSuccess ? "PROVIDER" : "SYSTEM",
        description: `[Reconstructed] Payment retry attempt #${attempt.attemptNumber}: ${attempt.status}`,
        payload: {
          attemptId: attempt.id,
          paymentId: attempt.paymentId,
          attemptNumber: attempt.attemptNumber,
          status: attempt.status,
          providerReference: attempt.providerReference,
          failureCode: attempt.failureCode,
          reconstructed: true,
        },
        occurredAt: attempt.resolvedAt ?? attempt.requestedAt,
      });

      details.push({
        caseId: linkedCase.id,
        eventType,
        entityId: attempt.id,
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
