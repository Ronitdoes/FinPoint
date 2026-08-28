import type { FastifyInstance } from "fastify";
import type { DomainEvent, RiskType } from "@repo/domain";
import {
  GROUP_ORCHESTRATOR,
  TOPIC_MAIN,
  type EventContext,
} from "@repo/integrations";
import {
  DefaultWorkflowClient,
  type RecoveryWorkflowClient,
} from "@repo/orchestration";
import { getLogger } from "@repo/observability";
import { CaseCreationService } from "./creation.service";
import { CasePipelineService } from "./pipeline.service";

const logger = getLogger({ component: "cases-consumer" });

export class CaseConsumerHandler {
  private readonly creationService: CaseCreationService;
  private readonly pipelineService: CasePipelineService;
  private readonly workflowClient: RecoveryWorkflowClient;

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
    this.workflowClient =
      (app as any).workflowClient ?? new DefaultWorkflowClient(app.db);
  }

  async handleDomainEvent(
    event: DomainEvent,
    _ctx?: EventContext,
  ): Promise<void> {
    switch (event.type) {
      case "checkout.started":
        await this.handleCheckoutStarted(event);
        break;

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
   * Handles checkout.started: Creates a lightweight WATCH record on the checkout
   * and starts the CheckoutAbandonmentWorkflow (Spec 23 §Requirements 1).
   */
  private async handleCheckoutStarted(event: DomainEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      checkoutId?: string;
      customerId?: string;
      cartValue?: string | number;
      currency?: string;
    };

    const tenantId = event.tenant_id;
    const checkoutId = payload.checkoutId ?? event.entity_id;

    logger.info(
      { tenantId, checkoutId },
      "Received checkout.started; checking watchability",
    );

    // Verify checkout exists and is watchable (prevents duplicate workflows)
    const watchableInfo = await this.app.repos.findWatchable(
      { db: this.app.db },
      { tenantId, checkoutId },
    );

    if (!watchableInfo.watchable) {
      logger.info(
        { tenantId, checkoutId, alreadyStarted: watchableInfo.alreadyStarted },
        "Checkout is not watchable or watch workflow already active; skipping duplicate watch initiation",
      );
      return;
    }

    // Record WATCH_STARTED event to append-only cart ledger
    await this.app.repos.recordCheckoutEvent(
      { db: this.app.db },
      {
        tenantId,
        checkoutId,
        type: "WATCH_STARTED",
        payload: {
          abandonment_workflow_started: true,
          startedAt: new Date().toISOString(),
          correlationId: event.correlation_id,
        },
      },
    );

    // Start the CheckoutAbandonmentWorkflow
    await this.workflowClient.startRecoveryWorkflow({
      tenantId,
      caseId: checkoutId,
      workflowType: "CheckoutAbandonmentWorkflow",
      actions: [],
      db: this.app.db,
    });

    logger.info(
      { tenantId, checkoutId },
      "Checkout watch record established; abandonment workflow initiated",
    );
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
