import { randomUUID } from "node:crypto";
import type { Database } from "@repo/db";
import { isUniqueViolation, withTransaction } from "@repo/db";
import type { DomainEvent, EntityType } from "@repo/domain";
import { TOPIC_MAIN, type EventBus } from "@repo/integrations";
import {
  getLogger,
  recordCaseFunnel,
  withSpan,
} from "@repo/observability";
import type { Repositories } from "../../plugins/db";
import type { TryCreateCaseInput, TryCreateCaseResult } from "./case.types";

const logger = getLogger({ component: "case-creation-service" });

export class CaseCreationService {
  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
    private readonly eventBus?: EventBus,
  ) {}

  /**
   * Idempotently creates a recovery case for an obligation risk (Spec 01 §12, Step 17).
   *
   * 1. SELECT live case for obligation -> return { case: existing, created: false }
   * 2. In transaction: INSERT (DETECTED) -> transition QUALIFIED -> record timeline & audit logs.
   * 3. On 23505 race condition: re-select live case -> { case: existing, created: false }
   * 4. Publish `case.opened` event to `revenue-events.v1` to trigger asynchronous pipeline.
   */
  async tryCreateCase(
    input: TryCreateCaseInput,
  ): Promise<TryCreateCaseResult> {
    return await withSpan(
      "case.create",
      {
        "tenant.id": input.tenantId,
        "customer.id": input.customerId,
        "source.type": input.sourceEntityType,
        "source.id": input.sourceEntityId,
        "risk.type": input.riskType,
      },
      async () => {
        // 1. Check if subject already has a live case (anti-duplication anchor #2)
        const existingLive = await this.repos.findLiveCaseByObligation(
          { db: this.db },
          {
            tenantId: input.tenantId,
            sourceEntityType: input.sourceEntityType,
            sourceEntityId: input.sourceEntityId,
          },
        );

        if (existingLive) {
          logger.info(
            {
              tenantId: input.tenantId,
              caseId: existingLive.id,
              sourceEntityType: input.sourceEntityType,
              sourceEntityId: input.sourceEntityId,
            },
            "Existing live recovery case found for obligation; skipping duplicate creation",
          );
          return { case: existingLive, created: false };
        }

        // 2. Transactional case creation: DETECTED -> QUALIFIED + timeline event + audit log
        try {
          const resultCase = await withTransaction(
            { db: this.db },
            async (tx) => {
              const created = await this.repos.createCaseInTx(tx, {
                tenantId: input.tenantId,
                customerId: input.customerId,
                riskId: input.riskId,
                riskType: input.riskType,
                sourceEntityType: input.sourceEntityType,
                sourceEntityId: input.sourceEntityId,
                amountAtRisk: BigInt(input.amountAtRisk),
                currency: input.currency,
                riskScore: input.riskScore,
                status: "DETECTED",
                stopConditions: input.stopConditions ?? [],
                attributionWindowHours: input.attributionWindowHours ?? 72,
              });

              const qualified = await this.repos.transitionCaseStatus(
                { tx },
                {
                  tenantId: input.tenantId,
                  caseId: created.id,
                  from: ["DETECTED"],
                  to: "QUALIFIED",
                  reason: "Risk evaluated and qualified for recovery",
                },
              );

              const activeCase = qualified ?? created;

              // Timeline event for case qualification
              await this.repos.recordCaseEvent(
                { tx },
                {
                  tenantId: input.tenantId,
                  caseId: activeCase.id,
                  eventType: "RISK_CALCULATED",
                  actorType: "SYSTEM",
                  description: `Recovery case opened for ${input.riskType} with score ${input.riskScore}`,
                  payload: {
                    riskId: input.riskId,
                    riskType: input.riskType,
                    riskScore: input.riskScore,
                    amountAtRisk: Number(input.amountAtRisk),
                    currency: input.currency,
                    caseNumber: activeCase.caseNumber,
                  },
                },
              );

              // Audit log entry
              await this.repos.recordAuditLog(
                { tx },
                {
                  tenantId: input.tenantId,
                  caseId: activeCase.id,
                  actorType: "SYSTEM",
                  event: "CASE_CREATED",
                  metadata: {
                    caseNumber: activeCase.caseNumber,
                    riskId: input.riskId,
                    riskType: input.riskType,
                    amountAtRisk: Number(input.amountAtRisk),
                    currency: input.currency,
                  },
                  correlationId: input.correlationId,
                },
              );

              return activeCase;
            },
          );

          // Funnel metrics
          recordCaseFunnel("opened");
          recordCaseFunnel("qualified");

          // 3. Publish case.opened domain event to trigger asynchronous pipeline
          if (this.eventBus) {
            const caseOpenedEvent: DomainEvent = {
              id: randomUUID(),
              type: "case.opened",
              occurred_at: new Date().toISOString(),
              source: "orchestrator",
              tenant_id: input.tenantId,
              customer_id: input.customerId,
              entity_id: resultCase.id,
              entity_type:
                (input.sourceEntityType.toUpperCase() as EntityType) ||
                "PAYMENT",
              payload: {
                caseId: resultCase.id,
                caseNumber: resultCase.caseNumber,
                riskId: resultCase.riskId,
                riskType: resultCase.riskType,
                sourceEntityType: resultCase.sourceEntityType,
                sourceEntityId: resultCase.sourceEntityId,
                amountAtRisk: Number(resultCase.amountAtRisk),
                currency: resultCase.currency,
                riskScore: resultCase.riskScore,
                status: resultCase.status,
              },
              correlation_id: input.correlationId ?? randomUUID(),
              traceparent: input.traceparent,
            };

            await this.eventBus.publish(caseOpenedEvent, {
              topic: TOPIC_MAIN,
              key: input.tenantId,
            });
          }

          logger.info(
            {
              tenantId: input.tenantId,
              caseId: resultCase.id,
              caseNumber: resultCase.caseNumber,
            },
            "Recovery case created and qualified",
          );

          return { case: resultCase, created: true };
        } catch (error: any) {
          // Concurrency race: another process created a live case for this obligation
          if (isUniqueViolation(error)) {
            logger.info(
              {
                tenantId: input.tenantId,
                sourceEntityType: input.sourceEntityType,
                sourceEntityId: input.sourceEntityId,
              },
              "Unique constraint collision on concurrent case creation; re-selecting winner",
            );

            const raceWinner = await this.repos.findLiveCaseByObligation(
              { db: this.db },
              {
                tenantId: input.tenantId,
                sourceEntityType: input.sourceEntityType,
                sourceEntityId: input.sourceEntityId,
              },
            );

            if (raceWinner) {
              return { case: raceWinner, created: false };
            }
          }

          throw error;
        }
      },
    );
  }
}
