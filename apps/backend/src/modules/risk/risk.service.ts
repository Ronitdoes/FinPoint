import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DomainEvent } from "@repo/domain";
import {
  TOPIC_MAIN,
  NonRetryableError,
} from "@repo/integrations";
import {
  recordRiskCalculation,
  withSpan,
} from "@repo/observability";
import type { RevenueRisk } from "@repo/db";
import { scorePaymentFailure } from "./engine/score-payment-failure";
import { scoreCheckout } from "./engine/score-checkout";
import { scoreInvoice } from "./engine/score-invoice";
import type {
  RiskScoreResult,
  RiskScoringConfig,
  SubjectAggregates,
} from "./risk.types";

/**
 * Service orchestrating deterministic risk evaluations, factor persistence,
 * risk closure, and domain event publication.
 */
export class RiskService {
  constructor(private readonly app: FastifyInstance) {}

  /**
   * Handles inbound domain events from the bus (consumer group: risk-engine).
   */
  async handleDomainEvent(
    event: DomainEvent,
    _ctx?: unknown,
  ): Promise<void> {
    const startTime = performance.now();

    switch (event.type) {
      case "payment.failed":
        await this.processPaymentFailedEvent(event, startTime);
        break;

      case "checkout.abandoned":
        await this.processCheckoutAbandonedEvent(event, startTime);
        break;

      case "invoice.overdue":
        await this.processInvoiceOverdueEvent(event, startTime);
        break;

      case "payment.succeeded":
        await this.closeOpenRisksForSubject(
          event.tenant_id,
          "PAYMENT",
          event.entity_id,
        );
        break;

      case "invoice.paid":
        await this.closeOpenRisksForSubject(
          event.tenant_id,
          "INVOICE",
          event.entity_id,
        );
        break;

      case "checkout.completed":
        await this.closeOpenRisksForSubject(
          event.tenant_id,
          "CHECKOUT",
          event.entity_id,
        );
        break;

      default:
        // Other events are non-trigger events for the risk engine
        break;
    }
  }

  /**
   * Evaluates and records payment failure risk.
   */
  private async processPaymentFailedEvent(
    event: DomainEvent,
    startTime: number,
  ): Promise<void> {
    const tenantId = event.tenant_id;
    const paymentId = event.entity_id;

    // Load subject aggregates via repository layer only
    const [customer, payment] = await Promise.all([
      this.app.repos.findCustomerById(
        { db: this.app.db },
        { tenantId, customerId: event.customer_id },
      ),
      this.app.repos.findPaymentById(
        { db: this.app.db },
        { tenantId, paymentId },
      ),
    ]);

    if (!customer) {
      this.app.log.warn(
        { tenantId, customerId: event.customer_id, paymentId },
        "Customer entity not found for payment.failed risk evaluation; skipping",
      );
      throw new NonRetryableError(
        `Customer not found: ${event.customer_id} for tenant ${tenantId}`,
      );
    }

    const [subscriptions, paymentsHistory, paymentAttempts] = await Promise.all([
      this.app.repos.listSubscriptionsForCustomer(
        { db: this.app.db },
        { tenantId, customerId: customer.id },
      ),
      this.app.repos.listPaymentsForCustomer(
        { db: this.app.db },
        { tenantId, customerId: customer.id, limit: 100 },
      ),
      payment
        ? this.app.repos.findPaymentAttemptsByPaymentId(
            { db: this.app.db },
            { tenantId, paymentId: payment.id },
          )
        : Promise.resolve([]),
    ]);

    const aggregates: SubjectAggregates = {
      tenantId,
      customerId: customer.id,
      customer,
      payment,
      subscriptions,
      paymentsHistory,
      paymentAttempts,
      now: new Date(),
    };

    const evaluationResult = await withSpan(
      "risk.calculate",
      {
        "risk.type": "PAYMENT_FAILURE",
        "subject.type": "PAYMENT",
        "subject.id": paymentId,
        "tenant.id": tenantId,
      },
      async () => scorePaymentFailure(aggregates),
    );

    await this.persistAndEmitRisk(
      event,
      "PAYMENT",
      paymentId,
      evaluationResult,
      startTime,
    );
  }

  /**
   * Evaluates and records checkout abandonment risk.
   */
  private async processCheckoutAbandonedEvent(
    event: DomainEvent,
    startTime: number,
  ): Promise<void> {
    const tenantId = event.tenant_id;
    const checkoutId = event.entity_id;

    const [customer, checkout] = await Promise.all([
      this.app.repos.findCustomerById(
        { db: this.app.db },
        { tenantId, customerId: event.customer_id },
      ),
      this.app.repos.findCheckoutById(
        { db: this.app.db },
        { tenantId, checkoutId },
      ),
    ]);

    if (!customer) {
      this.app.log.warn(
        { tenantId, customerId: event.customer_id, checkoutId },
        "Customer entity not found for checkout.abandoned risk evaluation; skipping",
      );
      throw new NonRetryableError(
        `Customer not found: ${event.customer_id} for tenant ${tenantId}`,
      );
    }

    const [subscriptions, paymentsHistory, checkoutEvents] = await Promise.all([
      this.app.repos.listSubscriptionsForCustomer(
        { db: this.app.db },
        { tenantId, customerId: customer.id },
      ),
      this.app.repos.listPaymentsForCustomer(
        { db: this.app.db },
        { tenantId, customerId: customer.id, limit: 100 },
      ),
      checkout
        ? this.app.repos.listCheckoutEvents(
            { db: this.app.db },
            { checkoutId: checkout.id },
          )
        : Promise.resolve([]),
    ]);

    const aggregates: SubjectAggregates = {
      tenantId,
      customerId: customer.id,
      customer,
      checkout,
      subscriptions,
      paymentsHistory,
      checkoutEvents,
      now: new Date(),
    };

    const evaluationResult = await withSpan(
      "risk.calculate",
      {
        "risk.type": "CHECKOUT_ABANDONMENT",
        "subject.type": "CHECKOUT",
        "subject.id": checkoutId,
        "tenant.id": tenantId,
      },
      async () => scoreCheckout(aggregates),
    );

    await this.persistAndEmitRisk(
      event,
      "CHECKOUT",
      checkoutId,
      evaluationResult,
      startTime,
    );
  }

  /**
   * Evaluates and records invoice overdue risk.
   */
  private async processInvoiceOverdueEvent(
    event: DomainEvent,
    startTime: number,
  ): Promise<void> {
    const tenantId = event.tenant_id;
    const invoiceId = event.entity_id;

    const [customer, invoice] = await Promise.all([
      this.app.repos.findCustomerById(
        { db: this.app.db },
        { tenantId, customerId: event.customer_id },
      ),
      this.app.repos.findInvoiceById(
        { db: this.app.db },
        { tenantId, invoiceId },
      ),
    ]);

    if (!customer) {
      this.app.log.warn(
        { tenantId, customerId: event.customer_id, invoiceId },
        "Customer entity not found for invoice.overdue risk evaluation; skipping",
      );
      throw new NonRetryableError(
        `Customer not found: ${event.customer_id} for tenant ${tenantId}`,
      );
    }

    const [subscriptions, paymentsHistory] = await Promise.all([
      this.app.repos.listSubscriptionsForCustomer(
        { db: this.app.db },
        { tenantId, customerId: customer.id },
      ),
      this.app.repos.listPaymentsForCustomer(
        { db: this.app.db },
        { tenantId, customerId: customer.id, limit: 100 },
      ),
    ]);

    const aggregates: SubjectAggregates = {
      tenantId,
      customerId: customer.id,
      customer,
      invoice,
      subscriptions,
      paymentsHistory,
      now: new Date(),
    };

    const evaluationResult = await withSpan(
      "risk.calculate",
      {
        "risk.type": "INVOICE_OVERDUE",
        "subject.type": "INVOICE",
        "subject.id": invoiceId,
        "tenant.id": tenantId,
      },
      async () => scoreInvoice(aggregates),
    );

    await this.persistAndEmitRisk(
      event,
      "INVOICE",
      invoiceId,
      evaluationResult,
      startTime,
    );
  }

  /**
   * Persists the evaluated risk via upsertOpenRisk, emits risk.calculated domain event,
   * and records duration metrics / slow-evaluation warnings.
   */
  private async persistAndEmitRisk(
    triggerEvent: DomainEvent,
    subjectType: string,
    subjectId: string,
    result: RiskScoreResult,
    startTime: number,
  ): Promise<RevenueRisk> {
    const tenantId = triggerEvent.tenant_id;
    const customerId = triggerEvent.customer_id;
    const computedAt = new Date();

    // 1. Idempotently upsert OPEN risk
    const risk = await this.app.repos.upsertOpenRisk(
      { db: this.app.db },
      {
        tenantId,
        customerId,
        riskType: result.riskType,
        subjectType,
        subjectId,
        score: result.score,
        band: result.band,
        factors: result.factors as unknown as Record<string, unknown>,
        computedAt,
      },
    );

    // 2. If the risk is OPEN, emit internal domain event risk.calculated with correlation continuity
    if (risk.status === "OPEN") {
      const riskCalculatedEvent: DomainEvent = {
        id: randomUUID(),
        type: "risk.calculated",
        occurred_at: computedAt.toISOString(),
        source: "risk-engine",
        tenant_id: tenantId,
        customer_id: customerId,
        entity_id: risk.id,
        entity_type: triggerEvent.entity_type,
        payload: {
          riskId: risk.id,
          riskType: risk.riskType,
          band: risk.band,
          score: risk.score,
          subjectType: risk.subjectType,
          subjectId: risk.subjectId,
        },
        correlation_id: triggerEvent.correlation_id,
        traceparent: triggerEvent.traceparent,
      };

      await this.app.eventBus.publish(riskCalculatedEvent, {
        topic: TOPIC_MAIN,
        key: tenantId,
      });
    }

    // 3. Record metrics and check latency threshold (<50ms p95 target)
    const durationMs = performance.now() - startTime;
    recordRiskCalculation(risk.band, durationMs);

    if (durationMs > 50) {
      this.app.log.warn(
        {
          durationMs,
          riskId: risk.id,
          riskType: risk.riskType,
          score: risk.score,
          band: risk.band,
        },
        "Slow risk calculation detected (>50ms target)",
      );
    }

    return risk;
  }

  /**
   * Closes open risks on success events (payment.succeeded, invoice.paid, checkout.completed).
   */
  private async closeOpenRisksForSubject(
    tenantId: string,
    subjectType: string,
    subjectId: string,
  ): Promise<void> {
    const closedRisks = await this.app.repos.closeRisksForSubject(
      { db: this.app.db },
      {
        tenantId,
        subjectType,
        subjectId,
        reason: "resolved_upstream",
      },
    );

    if (closedRisks.length > 0) {
      this.app.log.info(
        {
          tenantId,
          subjectType,
          subjectId,
          closedCount: closedRisks.length,
        },
        "Closed matching OPEN risks as EXPIRED (resolved_upstream)",
      );
    }
  }
}
