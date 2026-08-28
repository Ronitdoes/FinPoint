import { findCheckoutById } from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
  createNonRetryableFailure,
} from "../framework";

export interface CheckCheckoutStatusInput extends ActivityContext {
  checkoutId: string;
  inactivityThresholdMinutes?: number;
}

export interface CheckCheckoutStatusResult {
  exists: boolean;
  status: string;
  isCompleted: boolean;
  completedAt?: string;
  isAbandoned: boolean;
  abandonedAt?: string;
  cartValue: string;
  currency: string;
  customerId?: string;
  lastActivityAt: string;
  startedAt: string;
}

/**
 * Activity: checkCheckoutStatus
 * Reads fresh checkout status from DB and evaluates whether the checkout
 * has been completed or abandoned.
 */
export async function checkCheckoutStatus(
  input: CheckCheckoutStatusInput,
): Promise<CheckCheckoutStatusResult> {
  return await withActivityContext("checkCheckoutStatus", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const checkout = await findCheckoutById(
        { db, tx },
        { tenantId: input.tenantId, checkoutId: input.checkoutId },
      );

      if (!checkout) {
        throw createNonRetryableFailure(
          `Checkout '${input.checkoutId}' not found for tenant '${input.tenantId}'`,
          "ENTITY_NOT_FOUND",
        );
      }

      const isCompleted = checkout.status === "COMPLETED" || checkout.completedAt !== null;
      const isAbandoned = checkout.status === "ABANDONED" || checkout.abandonedAt !== null;

      return {
        exists: true,
        status: checkout.status,
        isCompleted,
        completedAt: checkout.completedAt?.toISOString(),
        isAbandoned,
        abandonedAt: checkout.abandonedAt?.toISOString(),
        cartValue: checkout.cartValue.toString(),
        currency: checkout.currency,
        customerId: checkout.customerId,
        lastActivityAt: checkout.lastActivityAt.toISOString(),
        startedAt: checkout.startedAt.toISOString(),
      };
    });
  });
}
