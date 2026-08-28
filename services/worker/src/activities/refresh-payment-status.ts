import {
  findPaymentById,
  updatePaymentStatus,
  recordCaseEvent,
} from "@repo/db";
import { resolvePaymentProvider, type PaymentProvider } from "@repo/integrations";
import { workerConfig } from "@repo/config";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
  sendActivityHeartbeat,
  createNonRetryableFailure,
} from "../framework";

export interface RefreshPaymentStatusInput extends ActivityContext {
  paymentId: string;
  providerPaymentId?: string;
  provider?: string;
}

export interface RefreshPaymentStatusResult {
  status: "SUCCEEDED" | "FAILED" | "PENDING" | "UNKNOWN";
  paymentId: string;
  providerStatus?: string;
  settledAt?: string;
}

/**
 * Activity: refreshPaymentStatus
 * Polls payment provider for latest status of a pending/unknown transaction,
 * with activity heartbeat support.
 */
export async function refreshPaymentStatus(
  input: RefreshPaymentStatusInput,
): Promise<RefreshPaymentStatusResult> {
  return await withActivityContext("refreshPaymentStatus", input, async () => {
    sendActivityHeartbeat({ step: "query_payment", paymentId: input.paymentId });

    return await withActivityDb(input, async (db, tx) => {
      const payment = await findPaymentById(
        { db, tx },
        { tenantId: input.tenantId, paymentId: input.paymentId },
      );

      if (!payment) {
        throw createNonRetryableFailure(
          `Payment '${input.paymentId}' not found`,
          "ENTITY_NOT_FOUND",
        );
      }

      const config = workerConfig();
      const providerName = (input.provider ?? payment.provider ?? "mock").toLowerCase();
      const adapter: PaymentProvider = resolvePaymentProvider({
        provider: providerName,
        paymentsConfig: config.payments,
        demoConfig: config.demo,
      });

      const providerPaymentId =
        input.providerPaymentId ?? payment.providerPaymentId ?? input.paymentId;

      const refreshResult = await adapter.getPaymentStatus(providerPaymentId);

      sendActivityHeartbeat({ step: "status_received", status: refreshResult.status });

      const mappedStatus: "SUCCEEDED" | "FAILED" | "PENDING" | "UNKNOWN" =
        refreshResult.status === "SUCCEEDED"
          ? "SUCCEEDED"
          : refreshResult.status === "FAILED"
            ? "FAILED"
            : refreshResult.status === "PENDING"
              ? "PENDING"
              : "UNKNOWN";

      if (mappedStatus === "SUCCEEDED" && payment.status !== "SUCCEEDED") {
        await updatePaymentStatus(
          { db, tx },
          {
            tenantId: input.tenantId,
            paymentId: payment.id,
            status: "SUCCEEDED",
            paidAt: new Date(),
          },
        );

        await recordCaseEvent(
          { db, tx },
          {
            tenantId: input.tenantId,
            caseId: input.caseId,
            eventType: "PAYMENT_STATUS_REFRESHED",
            actorType: "SYSTEM",
            description: "Payment status confirmed: SUCCEEDED",
            payload: {
              paymentId: payment.id,
              status: "SUCCEEDED",
            },
          },
        );
      } else if (mappedStatus === "FAILED" && payment.status !== "FAILED") {
        await updatePaymentStatus(
          { db, tx },
          {
            tenantId: input.tenantId,
            paymentId: payment.id,
            status: "FAILED",
          },
        );
      }

      return {
        status: mappedStatus,
        paymentId: payment.id,
        providerStatus: refreshResult.rawResponse ? JSON.stringify(refreshResult.rawResponse) : undefined,
        settledAt: mappedStatus === "SUCCEEDED" ? new Date().toISOString() : undefined,
      };
    });
  });
}
