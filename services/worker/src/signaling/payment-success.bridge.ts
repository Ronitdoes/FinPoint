import type { DomainEvent } from "@repo/domain";
import type { EventBus } from "@repo/integrations";
import { TOPIC_MAIN } from "@repo/integrations";
import { getLogger } from "@repo/observability";
import { findLiveCaseByObligation, type Database } from "@repo/db";
import type { RecoveryWorkflowClient } from "@repo/orchestration";
import { signalCase } from "../client";
import { SIGNAL_EXTERNAL_PAYMENT_SUCCEEDED } from "../workflows/shared";

const logger = getLogger({ component: "payment-success-bridge" });

export interface PaymentSuccessBridgeOptions {
  eventBus: EventBus;
  db?: Database;
  workflowClient?: RecoveryWorkflowClient;
}

/**
 * Event-reactive Signal Bridge for Payment Succeeded Events (Step 22 §Requirements 5).
 * Listens on revenue-events.v1 bus for payment.succeeded, finds active recovery cases
 * for the same obligation, and dispatches the 'external-payment-succeeded' signal
 * to close recovery workflows instantly.
 */
export class PaymentSuccessSignalBridge {
  private readonly eventBus: EventBus;
  private readonly db?: Database;
  private readonly workflowClient?: RecoveryWorkflowClient;

  constructor(options: PaymentSuccessBridgeOptions) {
    this.eventBus = options.eventBus;
    this.db = options.db;
    this.workflowClient = options.workflowClient;
  }

  public register(group: string = "payment-success-signal-bridge"): void {
    this.eventBus.subscribe(
      TOPIC_MAIN,
      group,
      async (event: DomainEvent) => {
        await this.handleDomainEvent(event);
      },
    );
    logger.info(
      { group, topic: TOPIC_MAIN },
      "Payment success signal bridge registered",
    );
  }

  public async handleDomainEvent(
    event: DomainEvent,
  ): Promise<void> {
    if (event.type !== "payment.succeeded") {
      return;
    }

    const tenantId = event.tenant_id;
    const payload = (event.payload ?? {}) as {
      paymentId?: string;
      amount?: string | number;
      currency?: string;
    };
    const paymentId = payload.paymentId ?? event.entity_id;

    if (!paymentId) {
      return;
    }

    try {
      const activeCase = await findLiveCaseByObligation(
        { db: this.db },
        {
          tenantId,
          sourceEntityType: "PAYMENT",
          sourceEntityId: paymentId,
        },
      );

      if (activeCase) {
        logger.info(
          { tenantId, paymentId, caseId: activeCase.id },
          "Active recovery case found for external payment success; signaling workflow",
        );

        const signalPayload = {
          paymentId,
          amount: payload.amount,
          currency: payload.currency,
          paidAt: event.occurred_at,
        };

        if (this.workflowClient) {
          await this.workflowClient.signalCase({
            tenantId,
            caseId: activeCase.id,
            signal: SIGNAL_EXTERNAL_PAYMENT_SUCCEEDED,
            payload: signalPayload,
            db: this.db,
          });
        } else {
          await signalCase({
            tenantId,
            caseId: activeCase.id,
            signal: SIGNAL_EXTERNAL_PAYMENT_SUCCEEDED,
            payload: signalPayload,
            db: this.db,
          });
        }
      }
    } catch (err: unknown) {
      logger.error(
        { tenantId, paymentId, err },
        "Error in payment success signal bridge while checking for active cases",
      );
    }
  }
}

/**
 * Helper to instantiate and register the PaymentSuccessSignalBridge.
 */
export function registerPaymentSuccessBridge(
  eventBus: EventBus,
  db?: Database,
  workflowClient?: RecoveryWorkflowClient,
): PaymentSuccessSignalBridge {
  const bridge = new PaymentSuccessSignalBridge({ eventBus, db, workflowClient });
  bridge.register();
  return bridge;
}
