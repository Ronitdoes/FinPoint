import type { DomainEvent } from "@repo/domain";
import type { EventBus } from "@repo/integrations";
import { TOPIC_MAIN } from "@repo/integrations";
import { getLogger } from "@repo/observability";
import {
  findLiveCaseByObligation,
  findLiveCasesForCustomer,
  type Database,
} from "@repo/db";
import type { RecoveryWorkflowClient } from "@repo/orchestration";
import { signalCase } from "../client";
import {
  SIGNAL_CUSTOMER_REPLIED,
  SIGNAL_INVOICE_PAID,
  SIGNAL_DISPUTE_OPENED,
  SIGNAL_STOP,
} from "../workflows/shared";

const logger = getLogger({ component: "customer-response-bridge" });

export interface CustomerResponseBridgeOptions {
  eventBus: EventBus;
  db?: Database;
  workflowClient?: RecoveryWorkflowClient;
}

/**
 * Event-reactive Signal Bridge for Inbound Customer Responses & Invoice Events (Step 24 §Requirements 3 & 6).
 * Listens on revenue-events.v1 for:
 * - customer.replied -> bridges to 'customer-replied' signal
 * - customer.opted_out -> bridges to 'stop' signal with reason 'CUSTOMER_OPTED_OUT'
 * - invoice.paid -> bridges to 'invoice-paid' signal
 * - invoice.disputed -> bridges to 'dispute-opened' / 'stop' signal
 */
export class CustomerResponseSignalBridge {
  private readonly eventBus: EventBus;
  private readonly db?: Database;
  private readonly workflowClient?: RecoveryWorkflowClient;

  constructor(options: CustomerResponseBridgeOptions) {
    this.eventBus = options.eventBus;
    this.db = options.db;
    this.workflowClient = options.workflowClient;
  }

  public register(group: string = "customer-response-signal-bridge"): void {
    this.eventBus.subscribe(
      TOPIC_MAIN,
      group,
      async (event: DomainEvent) => {
        await this.handleDomainEvent(event);
      },
    );
    logger.info(
      { group, topic: TOPIC_MAIN },
      "Customer response signal bridge registered",
    );
  }

  public async handleDomainEvent(event: DomainEvent): Promise<void> {
    switch (event.type) {
      case "customer.replied":
        await this.handleCustomerReplied(event);
        break;

      case "customer.opted_out":
        await this.handleCustomerOptedOut(event);
        break;

      case "invoice.paid":
        await this.handleInvoicePaid(event);
        break;

      case "invoice.disputed":
        await this.handleInvoiceDisputed(event);
        break;

      default:
        break;
    }
  }

  private async handleCustomerReplied(event: DomainEvent): Promise<void> {
    const tenantId = event.tenant_id;
    const customerId = event.customer_id;
    const payload = (event.payload ?? {}) as {
      response_type?: string;
      text?: string;
      channel?: string;
      promisedByDate?: string;
      promisedAmountMinor?: string;
      message_ref?: string;
    };

    const responseType = payload.response_type ?? "REPLY";

    // Find active live cases for this customer
    const activeCases = await findLiveCasesForCustomer(
      { db: this.db },
      { tenantId, customerId },
    );

    if (activeCases.length === 0) {
      logger.info(
        { tenantId, customerId, responseType },
        "No active live recovery case found for customer reply",
      );
      return;
    }

    for (const c of activeCases) {
      try {
        if (responseType === "OPT_OUT") {
          await this.dispatchSignal(tenantId, c.id, SIGNAL_STOP, {
            reason: "CUSTOMER_OPTED_OUT",
          });
        } else if (responseType === "COMPLAINT" || responseType === "DISPUTE") {
          await this.dispatchSignal(tenantId, c.id, SIGNAL_DISPUTE_OPENED, {
            reason: payload.text ?? "CUSTOMER_DISPUTE",
            caseId: c.id,
          });
        } else {
          await this.dispatchSignal(tenantId, c.id, SIGNAL_CUSTOMER_REPLIED, {
            type: responseType,
            text: payload.text,
            channel: payload.channel,
            promisedByDate: payload.promisedByDate,
            promisedAmountMinor: payload.promisedAmountMinor,
            messageRef: payload.message_ref,
          });
        }
      } catch (err: unknown) {
        logger.error(
          { tenantId, caseId: c.id, err },
          "Error signaling case from customer response bridge",
        );
      }
    }
  }

  private async handleCustomerOptedOut(event: DomainEvent): Promise<void> {
    const tenantId = event.tenant_id;
    const customerId = event.customer_id;

    const activeCases = await findLiveCasesForCustomer(
      { db: this.db },
      { tenantId, customerId },
    );

    for (const c of activeCases) {
      try {
        await this.dispatchSignal(tenantId, c.id, SIGNAL_STOP, {
          reason: "CUSTOMER_OPTED_OUT",
        });
      } catch (err: unknown) {
        logger.error(
          { tenantId, caseId: c.id, err },
          "Error signaling stop on opt-out",
        );
      }
    }
  }

  private async handleInvoicePaid(event: DomainEvent): Promise<void> {
    const tenantId = event.tenant_id;
    const invoiceId = event.entity_id;
    const payload = (event.payload ?? {}) as {
      paymentId?: string;
      amount?: string | number;
      currency?: string;
    };

    const activeCase = await findLiveCaseByObligation(
      { db: this.db },
      {
        tenantId,
        sourceEntityType: "INVOICE",
        sourceEntityId: invoiceId,
      },
    );

    if (!activeCase) return;

    try {
      await this.dispatchSignal(tenantId, activeCase.id, SIGNAL_INVOICE_PAID, {
        invoiceId,
        paymentId: payload.paymentId ?? event.entity_id,
        amount: payload.amount,
        currency: payload.currency,
        paidAt: event.occurred_at,
      });
    } catch (err: unknown) {
      logger.error(
        { tenantId, caseId: activeCase.id, invoiceId, err },
        "Error signaling invoice-paid to workflow",
      );
    }
  }

  private async handleInvoiceDisputed(event: DomainEvent): Promise<void> {
    const tenantId = event.tenant_id;
    const invoiceId = event.entity_id;
    const payload = (event.payload ?? {}) as { reason?: string; disputeId?: string };

    const activeCase = await findLiveCaseByObligation(
      { db: this.db },
      {
        tenantId,
        sourceEntityType: "INVOICE",
        sourceEntityId: invoiceId,
      },
    );

    if (!activeCase) return;

    try {
      await this.dispatchSignal(tenantId, activeCase.id, SIGNAL_DISPUTE_OPENED, {
        invoiceId,
        caseId: activeCase.id,
        disputeId: payload.disputeId,
        reason: payload.reason ?? "INVOICE_DISPUTED",
        disputedAt: event.occurred_at,
      });
    } catch (err: unknown) {
      logger.error(
        { tenantId, caseId: activeCase.id, invoiceId, err },
        "Error signaling dispute-opened to workflow",
      );
    }
  }

  private async dispatchSignal(
    tenantId: string,
    caseId: string,
    signal: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    if (this.workflowClient) {
      await this.workflowClient.signalCase({
        tenantId,
        caseId,
        signal,
        payload,
        db: this.db,
      });
    } else {
      await signalCase({
        tenantId,
        caseId,
        signal,
        payload,
        db: this.db,
      });
    }
  }
}

/**
 * Helper to register CustomerResponseSignalBridge.
 */
export function registerCustomerResponseBridge(
  eventBus: EventBus,
  db?: Database,
  workflowClient?: RecoveryWorkflowClient,
): CustomerResponseSignalBridge {
  const bridge = new CustomerResponseSignalBridge({
    eventBus,
    db,
    workflowClient,
  });
  bridge.register();
  return bridge;
}
