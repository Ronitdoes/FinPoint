import type { Database } from "@repo/db";
import * as repos from "@repo/db/repositories";
import { redactPii } from "./pii-scanner";

export interface TimelineEntry {
  id: number;
  at: string;
  type: string;
  eventType: string;
  actor: {
    type: string;
    id: string | null;
  };
  description: string | null;
  data: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export interface GetTimelineParams {
  tenantId: string;
  caseId: string;
  types?: string[];
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
}

export interface GetTimelineResult {
  items: TimelineEntry[];
  nextCursor: string | null;
}

/**
 * Service for building the unified enriched case timeline (Spec 01 §17, Step 25).
 * Merges case_events with linked domain entities (decisions, policies, messages, payment attempts, human tasks).
 */
export class TimelineService {
  constructor(
    private readonly db: Database,
    private readonly repositories: typeof repos = repos,
  ) {}

  async getCaseTimeline(params: GetTimelineParams): Promise<GetTimelineResult> {
    const { tenantId, caseId, types, from, to, limit = 100, cursor, order = "asc" } = params;

    // 1. Fetch raw case events
    const { items: events, nextCursor } = await this.repositories.listCaseEventsWithCursor(
      { db: this.db },
      {
        tenantId,
        caseId,
        types,
        from,
        to,
        limit,
        cursor,
        order,
      },
    );

    if (events.length === 0) {
      return { items: [], nextCursor: null };
    }

    // 2. Determine which entity types need enrichment
    const eventTypes = new Set(events.map((e) => e.eventType));

    const needsDecisions = eventTypes.has("AI_DECISION_CREATED");
    const needsPolicies = eventTypes.has("POLICY_ALLOWED") || eventTypes.has("POLICY_REJECTED");
    const needsMessages = eventTypes.has("WHATSAPP_SENT") || eventTypes.has("EMAIL_SENT");
    const needsHumanTasks = eventTypes.has("HUMAN_TASK_CREATED") || eventTypes.has("HUMAN_DECISION_RECORDED");
    const needsPaymentAttempts = eventTypes.has("PAYMENT_RETRY_STARTED") || eventTypes.has("PAYMENT_SUCCEEDED");

    // 3. Batch load relevant linked entities in parallel (s-25 fix: payment
    // attempts are a real DB join, not payload echo)
    const [decisions, policyEvaluations, messages, humanTasks, paymentAttempts] =
      await Promise.all([
        needsDecisions
          ? this.repositories.listDecisionsForCase({ db: this.db }, { tenantId, caseId })
          : Promise.resolve([]),
        needsPolicies
          ? this.repositories.listPolicyEvaluationsForCase({ db: this.db }, { tenantId, caseId })
          : Promise.resolve([]),
        needsMessages
          ? this.repositories.listMessagesForCase({ db: this.db }, { tenantId, caseId })
          : Promise.resolve([]),
        needsHumanTasks
          ? this.repositories.listHumanTasksForCase({ db: this.db }, { tenantId, caseId })
          : Promise.resolve([]),
        needsPaymentAttempts
          ? this.loadPaymentAttemptsForCase(tenantId, caseId)
          : Promise.resolve([]),
      ]);

    // Build lookup maps by entity ID or type
    const decisionMap = new Map(decisions.map((d) => [d.id, d]));
    const policyMap = new Map(policyEvaluations.map((p) => [p.id, p]));
    const messageMap = new Map(messages.map((m) => [m.id, m]));
    const humanTaskMap = new Map(humanTasks.map((t) => [t.id, t]));
    const attemptMap = new Map(paymentAttempts.map((a: any) => [a.id, a]));

    // 4. Enrich and shape each timeline entry
    const enrichedItems: TimelineEntry[] = events.map((event) => {
      const rawPayload = (event.payload ?? {}) as Record<string, unknown>;
      const enrichedData: Record<string, unknown> = { ...rawPayload };

      switch (event.eventType) {
        case "AI_DECISION_CREATED": {
          const decisionId = rawPayload.decisionId as string | undefined;
          const decision = decisionId ? decisionMap.get(decisionId) : decisions[0];
          if (decision) {
            const rawRec = decision.outputRaw as {
              diagnosis?: string;
              actions?: Array<{ actionType: string; rank: number; parameters?: Record<string, unknown> }>;
              confidence?: number;
              stop_conditions?: unknown[];
            } | null;
            const recActions = Array.isArray(decision.recommendedActions)
              ? (decision.recommendedActions as Array<{ actionType: string; rank?: number }>)
              : [];
            enrichedData.diagnosis = decision.diagnosisCause ?? rawRec?.diagnosis ?? rawPayload.diagnosis;
            enrichedData.confidence = decision.diagnosisConfidence ? Number(decision.diagnosisConfidence) : rawPayload.confidence;
            enrichedData.topAction = recActions[0]?.actionType ?? rawRec?.actions?.[0]?.actionType ?? rawPayload.topAction;
            enrichedData.promptVersion = decision.promptVersion ?? rawPayload.promptVersion;
            enrichedData.model = decision.model ?? rawPayload.model;
            if (decision.costMinorUnits) {
              enrichedData.costPaise = Number(decision.costMinorUnits);
            }
          }
          break;
        }

        case "POLICY_ALLOWED":
        case "POLICY_REJECTED": {
          const evalId = rawPayload.evaluationId as string | undefined;
          const evaluation = evalId ? policyMap.get(evalId) : policyEvaluations[0];
          if (evaluation) {
            enrichedData.verdict = evaluation.result;
            enrichedData.evaluatedRulesCount = Array.isArray(evaluation.ruleVersions)
              ? evaluation.ruleVersions.length
              : undefined;
            if (Array.isArray(evaluation.rejections) && evaluation.rejections.length > 0) {
              enrichedData.rejections = evaluation.rejections;
            }
          }
          break;
        }

        case "WHATSAPP_SENT":
        case "EMAIL_SENT": {
          const msgId = rawPayload.messageId as string | undefined;
          const message = msgId ? messageMap.get(msgId) : messages[0];
          if (message) {
            enrichedData.channel = message.channel;
            enrichedData.template = message.templateId ?? (message as any).templateName;
            enrichedData.status = message.status;
            enrichedData.providerMessageId = message.providerMessageId;
            if ((message as any).failureReason) {
              enrichedData.failureReason = (message as any).failureReason;
            }
          }
          break;
        }

        case "HUMAN_TASK_CREATED":
        case "HUMAN_DECISION_RECORDED": {
          const taskId = rawPayload.taskId as string | undefined;
          const task = taskId ? humanTaskMap.get(taskId) : humanTasks[0];
          if (task) {
            enrichedData.taskType = task.type;
            enrichedData.taskStatus = task.status;
            enrichedData.decidedBy = task.decidedBy ?? (task as any).operatorId;
            if (task.decisionNotes || (task as any).notes) {
              enrichedData.notes = task.decisionNotes ?? (task as any).notes;
            }
          }
          break;
        }

        case "PAYMENT_RETRY_STARTED":
        case "PAYMENT_SUCCEEDED": {
          const attemptId = rawPayload.attemptId as string | undefined;
          const attempt = attemptId
            ? attemptMap.get(attemptId)
            : (paymentAttempts as any[])[0];
          if (attempt) {
            enrichedData.attemptId = (attempt as any).id;
            enrichedData.attemptNumber = (attempt as any).attemptNumber;
            enrichedData.attemptStatus = (attempt as any).status;
            enrichedData.providerReference =
              (attempt as any).providerReference ?? rawPayload.gateway;
            enrichedData.failureCode =
              (attempt as any).failureCode ??
              rawPayload.declineCode ??
              rawPayload.failureCode;
            enrichedData.error =
              (attempt as any).error ?? rawPayload.error;
          } else {
            enrichedData.attemptNumber = rawPayload.attemptNumber;
            enrichedData.gateway = rawPayload.gateway;
            enrichedData.status = rawPayload.status;
            if (rawPayload.declineCode || rawPayload.failureCode) {
              enrichedData.declineCode = rawPayload.declineCode || rawPayload.failureCode;
            }
          }
          break;
        }
      }

      // Redact any unmasked PII from data
      const sanitizedData = redactPii(enrichedData);

      // TODO(s-25): audit-alias-sunset `type`/`data` are canonical; `eventType`/`payload`
      // are backwards-compat aliases kept for old
      // case-orchestration-integration.test.ts consumers. Sunset plan (pending spec
      // sign-off): announce deprecation, migrate clients/tests to canonical keys,
      // then remove aliases in a minor bump. Do NOT remove yet — breaking change.
      return {
        id: event.id,
        at: event.occurredAt.toISOString(),
        type: event.eventType,
        eventType: event.eventType,
        actor: {
          type: event.actorType,
          id: event.actorId ?? null,
        },
        description: event.description ?? null,
        data: sanitizedData,
        payload: sanitizedData,
      };
    });

    return {
      items: enrichedItems,
      nextCursor,
    };
  }

  private async loadPaymentAttemptsForCase(
    tenantId: string,
    caseId: string,
  ): Promise<any[]> {
    try {
      const c = await this.repositories.findCaseById(
        { db: this.db },
        { tenantId, caseId },
      );
      if (c?.sourceEntityType === "PAYMENT" && c.sourceEntityId) {
        return await this.repositories.findPaymentAttemptsByPaymentId(
          { db: this.db },
          { tenantId, paymentId: c.sourceEntityId },
        );
      }
    } catch {
      // Best-effort enrichment; timeline must never fail on DB miss.
    }
    return [];
  }
}
