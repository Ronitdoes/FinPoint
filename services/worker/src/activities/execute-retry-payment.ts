import {
  findPaymentById,
  createPaymentAttempt,
  updatePaymentStatus,
  completeAction,
  failAction,
  recordCaseEvent,
} from "@repo/db";
import { resolvePaymentProvider, type PaymentProvider } from "@repo/integrations";
import { workerConfig } from "@repo/config";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
  createNonRetryableFailure,
  checkFaultPoint,
} from "../framework";

export interface ExecuteRetryPaymentInput extends ActivityContext {
  paymentId: string;
  attemptNumber: number;
  actionId?: string;
  provider?: string;
  amountMinor?: string | bigint;
  currency?: string;
  customerId?: string;
  customerEmail?: string;
  paymentMethodId?: string;
}

export interface ExecuteRetryPaymentResult {
  status: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "ACCEPTED_ASYNC";
  attemptId: string;
  paymentId: string;
  declineCode?: string;
  declineMessage?: string;
}

/**
 * Activity: executeRetryPayment
 * Dispatches a payment retry to the configured payment provider with idempotency guarantees.
 */
export async function executeRetryPayment(
  input: ExecuteRetryPaymentInput,
): Promise<ExecuteRetryPaymentResult> {
  return await withActivityContext("executeRetryPayment", input, async () => {
    const config = workerConfig();

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

      const providerName = (input.provider ?? payment.provider ?? "mock").toLowerCase();
      const adapter: PaymentProvider = resolvePaymentProvider({
        provider: providerName,
        paymentsConfig: config.payments,
        demoConfig: config.demo,
      });

      const idempotencyKey = `${input.tenantId}:${input.caseId}:RETRY_PAYMENT:${input.attemptNumber}`;
      const amount = input.amountMinor ? BigInt(input.amountMinor) : payment.amount;
      const currency = input.currency ?? payment.currency;

      // Step 31: crash window before the money-moving side effect.
      await checkFaultPoint("executeRetryPayment", "before_provider_call", {
        tenantId: input.tenantId,
        caseId: input.caseId,
        idempotencyKey,
      });

      const retryResult = await adapter.retryPayment({
        tenantId: input.tenantId,
        caseId: input.caseId,
        paymentId: payment.id,
        amount,
        currency,
        customerId: input.customerId ?? payment.customerId,
        customerEmail: input.customerEmail,
        paymentMethodId: input.paymentMethodId ?? undefined,
        providerPaymentId: payment.providerPaymentId ?? undefined,
        idempotencyKey,
        attemptNumber: input.attemptNumber,
      });

      // Persist attempt in DB (step 31: post-provider crash window first).
      await checkFaultPoint("executeRetryPayment", "after_provider_call", {
        tenantId: input.tenantId,
        caseId: input.caseId,
        idempotencyKey,
        providerStatus: retryResult.status,
      });
      const attempt = await createPaymentAttempt(
        { db, tx },
        {
          tenantId: input.tenantId,
          paymentId: payment.id,
          attemptNumber: input.attemptNumber,
          status: retryResult.status === "SUCCEEDED" ? "SUCCEEDED" : "FAILED",
          idempotencyKey,
          initiatedBy: "RECOVERY_WORKFLOW",
          failureCode: retryResult.failureCode,
          error: retryResult.failureMessage ? { message: retryResult.failureMessage } : undefined,
          requestedAt: new Date(),
          resolvedAt: retryResult.status === "SUCCEEDED" ? new Date() : undefined,
        },
      );

      // Update payment status if succeeded
      if (retryResult.status === "SUCCEEDED") {
        await updatePaymentStatus(
          { db, tx },
          {
            tenantId: input.tenantId,
            paymentId: payment.id,
            status: "SUCCEEDED",
            paidAt: new Date(),
          },
        );
      }

      // If actionId was provided, complete or fail action
      if (input.actionId) {
        if (retryResult.status === "SUCCEEDED") {
          await completeAction(
            { db, tx },
            {
              tenantId: input.tenantId,
              actionId: input.actionId,
              result: {
                attemptId: attempt.id,
                status: retryResult.status,
              },
            },
          );
        } else {
          await failAction(
            { db, tx },
            {
              tenantId: input.tenantId,
              actionId: input.actionId,
              error: {
                attemptId: attempt.id,
                declineCode: retryResult.failureCode,
                message: retryResult.failureMessage,
              },
            },
          );
        }
      }

      // Record timeline event
      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: "PAYMENT_RETRY_ATTEMPTED",
          actorType: "SYSTEM",
          description: `Payment retry attempt #${input.attemptNumber}: ${retryResult.status}`,
          payload: {
            paymentId: payment.id,
            attemptId: attempt.id,
            status: retryResult.status,
            failureCode: retryResult.failureCode,
          },
        },
      );

      return {
        status: retryResult.status,
        attemptId: attempt.id,
        paymentId: payment.id,
        declineCode: retryResult.failureCode,
        declineMessage: retryResult.failureMessage,
      };
    });
  });
}
