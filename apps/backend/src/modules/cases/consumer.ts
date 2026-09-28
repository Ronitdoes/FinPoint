import type { FastifyInstance } from "fastify";
import type { DomainEvent, RiskType } from "@repo/domain";
import {
  GROUP_ORCHESTRATOR,
  GROUP_ORCHESTRATOR_RETRY,
  TOPIC_MAIN,
  TOPIC_RETRY,
  type EventContext,
} from "@repo/integrations";
import {
  type RecoveryWorkflowClient,
} from "@repo/orchestration";
import { LiveWorkflowClient } from "../../lib/live-workflow-client";
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
    // L1: live Temporal dispatch via worker client with DB-row fallback
    // (LiveWorkflowClient); injectable for tests via (app as any).workflowClient.
    this.workflowClient =
      (app as any).workflowClient ?? new LiveWorkflowClient(app.db);
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
   *
   * Non-blocking: schedules the heavy pipeline (LLM + policy + workflow start)
   * in the background via setImmediate (queueMicrotask fallback) and returns
   * immediately so the bus handler acks fast. Duplicate redelivery is safe:
   * runPipeline resumes from the first incomplete stage via guarded status +
   * append-only ledger.
   */
  private async handleCaseOpened(event: DomainEvent): Promise<void> {
    const payload = event.payload as { caseId?: string };
    const caseId = payload.caseId ?? event.entity_id;
    const tenantId = event.tenant_id;
    const correlationId = event.correlation_id;
    const traceparent = event.traceparent;

    logger.info(
      { tenant_id: tenantId, case_id: caseId, correlation_id: correlationId },
      "Received case.opened; scheduling asynchronous recovery pipeline",
    );

    const runInBackground = (): void => {
      this.pipelineService
        .runPipeline({ tenantId, caseId, correlationId, traceparent })
        .catch((err: unknown) => {
          logger.error(
            {
              tenant_id: tenantId,
              case_id: caseId,
              correlation_id: correlationId,
              err: err instanceof Error ? err.message : String(err),
            },
            "Background recovery pipeline failed; awaiting case.opened redelivery or manual rerun",
          );
        });
    };

    if (typeof setImmediate !== "undefined") {
      setImmediate(runInBackground);
    } else {
      queueMicrotask(runInBackground);
    }
  }
}

/**
 * Wires the orchestrator consumer group to the revenue-events.v1 topic (Spec 01 §0, s-17 §Requirements 1).
 * Also subscribes to RETRY (s-11 fix) so backoff retries are consumed.
 */
export function registerCaseConsumer(app: FastifyInstance): void {
  const handler = new CaseConsumerHandler(app);

  const onEvent = async (event: DomainEvent, ctx: EventContext) => {
    await handler.handleDomainEvent(event, ctx);
  };

  app.eventBus.subscribe(TOPIC_MAIN, GROUP_ORCHESTRATOR, onEvent);

  // Retry topic on its own group (s-11 fix v3 — see risk/consumer.ts).
  void Promise.resolve(
    app.eventBus.subscribe(TOPIC_RETRY, GROUP_ORCHESTRATOR_RETRY, onEvent),
  ).catch(() => {});

  app.log.info(
    { group: GROUP_ORCHESTRATOR, topic: TOPIC_MAIN },
    "Case orchestrator consumer group registered",
  );
}
