import type { DomainEvent } from "@repo/domain";
import type { EventBus } from "@repo/integrations";
import { TOPIC_MAIN } from "@repo/integrations";
import { getLogger } from "@repo/observability";
import { findLiveCaseByObligation, findCheckoutBySourceRef, type Database } from "@repo/db";
import type { RecoveryWorkflowClient } from "@repo/orchestration";
import { signalCase } from "../client";
import { SIGNAL_EXTERNAL_CHECKOUT_COMPLETED } from "../workflows/shared";

const logger = getLogger({ component: "checkout-completed-bridge" });

export interface CheckoutCompletedBridgeOptions {
  eventBus: EventBus;
  db?: Database;
  workflowClient?: RecoveryWorkflowClient;
}

/**
 * Event-reactive Signal Bridge for Checkout Completed Events (Step 23 §Requirements 6).
 * Listens on revenue-events.v1 bus for checkout.completed (and payment.succeeded with matching checkout),
 * finds active recovery cases or running watch workflows, and dispatches the
 * 'external-checkout-completed' signal to complete recovery workflows instantly.
 */
export class CheckoutCompletedSignalBridge {
  private readonly eventBus: EventBus;
  private readonly db?: Database;
  private readonly workflowClient?: RecoveryWorkflowClient;

  constructor(options: CheckoutCompletedBridgeOptions) {
    this.eventBus = options.eventBus;
    this.db = options.db;
    this.workflowClient = options.workflowClient;
  }

  public register(group: string = "checkout-completed-signal-bridge"): void {
    this.eventBus.subscribe(
      TOPIC_MAIN,
      group,
      async (event: DomainEvent) => {
        await this.handleDomainEvent(event);
      },
    );
    logger.info(
      { group, topic: TOPIC_MAIN },
      "Checkout completed signal bridge registered",
    );
  }

  public async handleDomainEvent(
    event: DomainEvent,
  ): Promise<void> {
    if (event.type !== "checkout.completed" && event.type !== "payment.succeeded") {
      return;
    }

    const tenantId = event.tenant_id;
    const payload = (event.payload ?? {}) as {
      checkoutId?: string;
      sourceRef?: string;
      amount?: string | number;
      currency?: string;
      paymentId?: string;
    };

    let checkoutId = payload.checkoutId;
    if (!checkoutId && event.type === "checkout.completed") {
      checkoutId = event.entity_id;
    }

    // If payment.succeeded arrived with a sourceRef matching a checkout, resolve checkoutId
    if (!checkoutId && payload.sourceRef) {
      try {
        const matchingCheckout = await findCheckoutBySourceRef(
          { db: this.db },
          { tenantId, sourceRef: payload.sourceRef },
        );
        if (matchingCheckout) {
          checkoutId = matchingCheckout.id;
        }
      } catch {
        // Non-blocking
      }
    }

    if (!checkoutId) {
      return;
    }

    try {
      // 1. Check if an active case exists for this checkout obligation
      const activeCase = await findLiveCaseByObligation(
        { db: this.db },
        {
          tenantId,
          sourceEntityType: "CHECKOUT",
          sourceEntityId: checkoutId,
        },
      );

      const targetId = activeCase ? activeCase.id : checkoutId;
      const signalPayload = {
        checkoutId,
        paymentId: payload.paymentId ?? (event.type === "payment.succeeded" ? event.entity_id : undefined),
        amount: payload.amount,
        currency: payload.currency,
        completedAt: event.occurred_at,
      };

      logger.info(
        { tenantId, checkoutId, targetId, hasActiveCase: !!activeCase },
        "Signaling checkout abandonment workflow with external checkout completed",
      );

      if (this.workflowClient) {
        await this.workflowClient.signalCase({
          tenantId,
          caseId: targetId,
          signal: SIGNAL_EXTERNAL_CHECKOUT_COMPLETED,
          payload: signalPayload,
          db: this.db,
        });
      } else {
        await signalCase({
          tenantId,
          caseId: targetId,
          signal: SIGNAL_EXTERNAL_CHECKOUT_COMPLETED,
          payload: signalPayload,
          db: this.db,
        });
      }
    } catch (err: unknown) {
      logger.error(
        { tenantId, checkoutId, err },
        "Error in checkout completed signal bridge while dispatching signal",
      );
    }
  }
}

/**
 * Helper to instantiate and register the CheckoutCompletedSignalBridge.
 */
export function registerCheckoutCompletedBridge(
  eventBus: EventBus,
  db?: Database,
  workflowClient?: RecoveryWorkflowClient,
): CheckoutCompletedSignalBridge {
  const bridge = new CheckoutCompletedSignalBridge({ eventBus, db, workflowClient });
  bridge.register();
  return bridge;
}
