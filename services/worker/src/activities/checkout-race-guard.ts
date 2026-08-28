import { completeRaceGuard } from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
  createNonRetryableFailure,
} from "../framework";

export interface CheckoutRaceGuardInput extends ActivityContext {
  checkoutId: string;
  step?: string;
}

export interface CheckoutRaceGuardResult {
  safeToSend: boolean;
  isCompleted: boolean;
  completedAt?: string;
  status: string;
}

/**
 * Activity: checkoutRaceGuard
 * Transactionally re-verifies checkout status immediately before any outbound
 * recovery message (reminder or incentive). If the customer purchased in the interim,
 * returns safeToSend: false so the workflow aborts the message.
 */
export async function checkoutRaceGuard(
  input: CheckoutRaceGuardInput,
): Promise<CheckoutRaceGuardResult> {
  return await withActivityContext("checkoutRaceGuard", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const result = await completeRaceGuard(
        { db, tx },
        {
          tenantId: input.tenantId,
          checkoutId: input.checkoutId,
          step: input.step ?? "1",
        },
      );

      if (!result.checkout) {
        throw createNonRetryableFailure(
          `Checkout '${input.checkoutId}' not found for tenant '${input.tenantId}'`,
          "ENTITY_NOT_FOUND",
        );
      }

      const isCompleted =
        result.checkout.status === "COMPLETED" ||
        result.checkout.completedAt !== null ||
        !result.safeToSend;

      return {
        safeToSend: result.safeToSend,
        isCompleted,
        completedAt: result.completedAt?.toISOString(),
        status: result.checkout.status,
      };
    });
  });
}
