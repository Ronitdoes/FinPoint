import type { FastifyInstance } from "fastify";
import type { DomainEvent, RiskType } from "@repo/domain";
import {
  GROUP_ORCHESTRATOR,
  TOPIC_MAIN,
  type EventContext,
} from "@repo/integrations";
import { getLogger } from "@repo/observability";
import { CaseCreationService } from "./creation.service";
import { CasePipelineService } from "./pipeline.service";

const logger = getLogger({ component: "cases-consumer" });

export class CaseConsumerHandler {
  private readonly creationService: CaseCreationService;
  private readonly pipelineService: CasePipelineService;

  constructor(private readonly app: FastifyInstance) {
    this.creationService = new CaseCreationService(
      app.db,
      app.repos,
      app.eventBus,
    );
    this.pipelineService = new CasePipelineService({
      db: app.db,
      repos: app.repos,
      config: app.config,
      redis: (app as any).redisClient,
    });
  }

  async handleDomainEvent(
    event: DomainEvent,
    _ctx?: EventContext,
  ): Promise<void> {
    switch (event.type) {
      case "risk.calculated":
        await this.handleRiskCalculated(event);
        break;

      case "case.opened":
        await this.handleCaseOpened(event);
        break;

      default:
        // Ignore other events in orchestrator group
        break;
    }
  }

  /**
   * Handles risk.calculated: Extracts obligation details, idempotently creates case in DETECTED->QUALIFIED state,
   * and publishes case.opened.
   */
  private async handleRiskCalculated(event: DomainEvent): Promise<void> {
    const payload = event.payload as {
      riskId?: string;
      riskType?: string;
      subjectType?: string;
      subjectId?: string;
      score?: number;
      amount?: number;
      currency?: string;
    };

    const tenantId = event.tenant_id;
    const customerId = event.customer_id;
    const riskId = payload.riskId ?? event.entity_id;
    const riskType = (payload.riskType ?? "PAYMENT_FAILURE") as RiskType;
    const subjectType = payload.subjectType ?? "PAYMENT";
    const subjectId = payload.subjectId ?? event.entity_id;
    const riskScore = payload.score ?? 50;

    let amountAtRisk = BigInt(payload.amount ?? 1000);
    let currency = payload.currency ?? "INR";

    // Lookup entity to obtain accurate financial amount if not supplied in payload
    if (!payload.amount) {
      if (subjectType === "PAYMENT") {
        const payment = await this.app.repos.findPaymentById(
          { db: this.app.db },
          { tenantId, paymentId: subjectId },
        );
        if (payment) {
          amountAtRisk = payment.amount;
          currency = payment.currency;
        }
      } else if (subjectType === "CHECKOUT") {
        const checkout = await this.app.repos.findCheckoutById(
          { db: this.app.db },
          { tenantId, checkoutId: subjectId },
        );
        if (checkout) {
          amountAtRisk = checkout.cartValue;
          currency = checkout.currency;
        }
      } else if (subjectType === "INVOICE") {
        const invoice = await this.app.repos.findInvoiceById(
          { db: this.app.db },
          { tenantId, invoiceId: subjectId },
        );
        if (invoice) {
          amountAtRisk = invoice.amount;
          currency = invoice.currency;
        }
      }
    }

    await this.creationService.tryCreateCase({
      tenantId,
      customerId,
      riskId,
      riskType,
      sourceEntityType: subjectType,
      sourceEntityId: subjectId,
      amountAtRisk,
      currency,
      riskScore,
      correlationId: event.correlation_id,
      traceparent: event.traceparent,
    });
  }

  /**
   * Handles case.opened: Triggers the multi-stage qualification and recovery pipeline asynchronously.
   */
  private async handleCaseOpened(event: DomainEvent): Promise<void> {
    const payload = event.payload as { caseId?: string };
    const caseId = payload.caseId ?? event.entity_id;

    logger.info(
      { tenantId: event.tenant_id, caseId },
      "Received case.opened; starting asynchronous recovery pipeline",
    );

    await this.pipelineService.runPipeline({
      tenantId: event.tenant_id,
      caseId,
      correlationId: event.correlation_id,
      traceparent: event.traceparent,
    });
  }
}

/**
 * Wires the orchestrator consumer group to the revenue-events.v1 topic (Spec 01 §0, s-17 §Requirements 1).
 */
export function registerCaseConsumer(app: FastifyInstance): void {
  const handler = new CaseConsumerHandler(app);

  app.eventBus.subscribe(
    TOPIC_MAIN,
    GROUP_ORCHESTRATOR,
    async (event: DomainEvent, ctx: EventContext) => {
      await handler.handleDomainEvent(event, ctx);
    },
  );

  app.log.info(
    { group: GROUP_ORCHESTRATOR, topic: TOPIC_MAIN },
    "Case orchestrator consumer group registered",
  );
}
