import {
  markPromiseHonored,
  markPromiseBroken,
  markPromiseExpired,
  resolvePromise,
} from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
} from "../framework";

export interface ResolvePromiseActivityInput extends ActivityContext {
  promiseId: string;
  status: "HONORED" | "BROKEN" | "EXPIRED";
  honoredPaymentId?: string;
  resolvedAt?: string;
}

export interface ResolvePromiseActivityResult {
  promiseId: string;
  status: string;
  resolvedAt: string;
  honoredPaymentId?: string;
}

/**
 * Activity: resolvePromiseToPayActivity
 * Transitions PTP status (HONORED, BROKEN, EXPIRED) with guarded conditional updates (Step 24).
 */
export async function resolvePromiseToPayActivity(
  input: ResolvePromiseActivityInput,
): Promise<ResolvePromiseActivityResult> {
  return await withActivityContext("resolvePromiseToPay", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const resolvedAtDate = input.resolvedAt
        ? new Date(input.resolvedAt)
        : new Date();

      let updated;
      if (input.status === "HONORED" && input.honoredPaymentId) {
        updated = await markPromiseHonored(
          { db, tx },
          {
            tenantId: input.tenantId,
            promiseId: input.promiseId,
            paymentId: input.honoredPaymentId,
            resolvedAt: resolvedAtDate,
          },
        );
      } else if (input.status === "BROKEN") {
        updated = await markPromiseBroken(
          { db, tx },
          {
            tenantId: input.tenantId,
            promiseId: input.promiseId,
            resolvedAt: resolvedAtDate,
          },
        );
      } else if (input.status === "EXPIRED") {
        updated = await markPromiseExpired(
          { db, tx },
          {
            tenantId: input.tenantId,
            promiseId: input.promiseId,
            resolvedAt: resolvedAtDate,
          },
        );
      }

      // Fallback to resolvePromise if status wasn't MADE or no specific transition returned
      if (!updated) {
        updated = await resolvePromise(
          { db, tx },
          {
            tenantId: input.tenantId,
            promiseId: input.promiseId,
            status: input.status,
            honoredPaymentId: input.honoredPaymentId,
            resolvedAt: resolvedAtDate,
          },
        );
      }

      return {
        promiseId: input.promiseId,
        status: updated?.status ?? input.status,
        resolvedAt: (updated?.resolvedAt ?? resolvedAtDate).toISOString(),
        honoredPaymentId: updated?.honoredPaymentId ?? input.honoredPaymentId,
      };
    });
  });
}
