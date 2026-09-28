import { randomUUID } from "node:crypto";
import {
  findOrphanedOverdueInvoices,
  findOverduePromises,
  findCaseById,
  findInvoiceById,
  listPaymentsForCustomer,
  markPromiseHonored,
  markPromiseBroken,
  markPromiseExpired,
  createHumanTask,
  recordCaseEvent,
  insertEventIfNew,
  type Database,
} from "@repo/db";
import type { EventBus } from "@repo/integrations";
import { TOPIC_MAIN } from "@repo/integrations";
import { getLogger } from "@repo/observability";
import type { DomainEvent } from "@repo/domain";

const logger = getLogger({ component: "reconciler-cron" });

export interface ReconcilerOptions {
  db?: Database;
  eventBus?: EventBus;
  tenantId: string;
}

export interface ReconcileOrphanedInvoicesResult {
  processedCount: number;
  emittedEvents: string[];
}

export interface ReconcileExpiredPromisesResult {
  processedCount: number;
  resolvedPromises: string[];
}

/**
 * Worker-side Scheduler Safety Net (Step 24 §Requirements 7).
 * Reconciles missed webhooks (orphaned OVERDUE invoices) and expired Promises to Pay.
 */
export class DailyReconciler {
  private readonly db?: Database;
  private readonly eventBus?: EventBus;

  constructor(options: { db?: Database; eventBus?: EventBus }) {
    this.db = options.db;
    this.eventBus = options.eventBus;
  }

  /**
   * Reconciles orphaned OVERDUE invoices that have no active recovery case
   * (e.g. Due to missed invoice.overdue webhooks or network partitions).
   * Idempotent (s-24 fix): deterministic `external_event_id` per invoice per
   * day via `insertEventIfNew`; repeat passes while the pipeline is slow/down
   * emit no duplicate bus events.
   */
  public async reconcileOrphanedInvoices(
    tenantId: string,
    limit: number = 50,
  ): Promise<ReconcileOrphanedInvoicesResult> {
    const orphanedInvoices = await findOrphanedOverdueInvoices(
      { db: this.db },
      { tenantId, limit },
    );

    const emittedEvents: string[] = [];
    const today = new Date().toISOString().slice(0, 10);

    for (const invoice of orphanedInvoices) {
      const correlationId = randomUUID();
      const externalEventId = `reconciler-invoice-${invoice.id}-${today}`;
      const payload = {
        invoice_id: invoice.id,
        invoice_number: invoice.number,
        amount: Number(invoice.amount),
        currency: invoice.currency,
        due_at: invoice.dueAt.toISOString(),
        reconciled: true,
      };

      // Dedupe anchor: only the first pass per day publishes.
      if (this.db) {
        try {
          const res = await insertEventIfNew(
            { db: this.db },
            {
              tenantId,
              source: "INTERNAL",
              externalEventId,
              type: "invoice.overdue",
              customerId: invoice.customerId,
              entityType: "INVOICE",
              entityId: invoice.id,
              rawPayload: payload,
              payload,
              correlationId,
              status: "RECEIVED",
              receivedAt: new Date(),
            },
          );
          if (res.duplicate) continue;
        } catch {
          // If the events table is unavailable, fall through to publish
          // (at-least-once) rather than skipping the orphan entirely.
        }
      }

      const event: DomainEvent = {
        id: randomUUID(),
        type: "invoice.overdue",
        occurred_at: new Date().toISOString(),
        source: "reconciler-cron",
        tenant_id: tenantId,
        customer_id: invoice.customerId,
        entity_id: invoice.id,
        entity_type: "INVOICE",
        payload: {
          ...payload,
          reconciler_event_id: externalEventId,
        },
        correlation_id: correlationId,
      };

      if (this.eventBus) {
        await this.eventBus.publish(event, { topic: TOPIC_MAIN, key: tenantId });
      }

      emittedEvents.push(invoice.id);

      logger.info(
        { tenantId, invoiceId: invoice.id, invoiceNumber: invoice.number },
        "Reconciler emitted invoice.overdue for orphaned invoice",
      );
    }

    return {
      processedCount: orphanedInvoices.length,
      emittedEvents,
    };
  }

  /**
   * Reconciles promises to pay that have passed their promised date + grace period
   * without being resolved by workflow signals.
   */
  public async reconcileExpiredPromises(
    tenantId: string,
    cutoffDate?: string | Date,
    limit: number = 50,
  ): Promise<ReconcileExpiredPromisesResult> {
    const overduePromises = await findOverduePromises(
      { db: this.db },
      { tenantId, cutoffDate, limit },
    );

    const resolvedPromises: string[] = [];

    for (const ptp of overduePromises) {
      try {
        const caseRecord = await findCaseById(
          { db: this.db },
          { tenantId, caseId: ptp.caseId },
        );

        let invoicePaid = false;
        let paymentId: string | undefined;

        if (caseRecord && caseRecord.sourceEntityType === "INVOICE") {
          const invoice = await findInvoiceById(
            { db: this.db },
            { tenantId, invoiceId: caseRecord.sourceEntityId },
          );
          if (invoice && (invoice.status === "PAID" || invoice.paidAt !== null)) {
            invoicePaid = true;
            // Link the real SUCCEEDED payment (s-24 fix): never fabricate a
            // UUID. If none is found, honor without a payment link rather
            // than corrupting the HONORED attribution chain.
            try {
              const payments = await listPaymentsForCustomer(
                { db: this.db },
                { tenantId, customerId: invoice.customerId, limit: 20 },
              );
              const match = payments.find((p) => p.status === "SUCCEEDED");
              paymentId = match?.id;
            } catch {
              paymentId = undefined;
            }
          }
        }

        if (invoicePaid) {
          await markPromiseHonored(
            { db: this.db },
            {
              tenantId,
              promiseId: ptp.id,
              paymentId,
              resolvedAt: new Date(),
            },
          );
        } else {
          // Unpaid past expiry: mark EXPIRED
          await markPromiseExpired(
            { db: this.db },
            {
              tenantId,
              promiseId: ptp.id,
              resolvedAt: new Date(),
            },
          );

          // Escalate case if still active
          if (
            caseRecord &&
            caseRecord.status !== "RECOVERED" &&
            caseRecord.status !== "STOPPED" &&
            caseRecord.status !== "FAILED"
          ) {
            const task = await createHumanTask(
              { db: this.db },
              {
                tenantId,
                caseId: caseRecord.id,
                type: "GENERAL",
                title: "Manual follow-up for expired promise to pay",
                description: `Promise to pay ${ptp.id} expired without payment. Escalated by reconciler.`,
                priority: "HIGH",
              },
            );

            await recordCaseEvent(
              { db: this.db },
              {
                tenantId,
                caseId: caseRecord.id,
                eventType: "CASE_ESCALATED",
                actorType: "SYSTEM",
                description: `Case escalated by daily reconciler for expired PTP ${ptp.id}`,
                payload: { taskId: task.id, promiseId: ptp.id },
              },
            );
          }
        }

        resolvedPromises.push(ptp.id);
      } catch (err: unknown) {
        logger.error(
          { tenantId, promiseId: ptp.id, err },
          "Error reconciling overdue promise to pay",
        );
      }
    }

    return {
      processedCount: overduePromises.length,
      resolvedPromises,
    };
  }
}
