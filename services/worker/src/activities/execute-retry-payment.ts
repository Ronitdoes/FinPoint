import {
  findPaymentById,
  findPaymentAttemptByIdempotencyKey,
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

      // Idempotency claim pre-check (s-22 audit): if a previous attempt with the same
      // deterministic key already exists (SUCCEEDED/PENDING/FAILED), return it without
      // re-invoking the provider. Concurrent racers that both pass this check are still
      // protected by the DB unique constraint on idempotency_key (see catch below);
      // crash-window duplicates are resolved by the s-31 EXECUTING sweeper via provider
      // status query, never blind re-execution.
      const existingAttempt = await findPaymentAttemptByIdempotencyKey(
        { db, tx },
        { tenantId: input.tenantId, idempotencyKey },
      );
      if (existingAttempt) {
        const mapped: "SUCCEEDED" | "FAILED" | "UNKNOWN" =
          existingAttempt.status === "SUCCEEDED"
            ? "SUCCEEDED"
            : existingAttempt.status === "FAILED"
              ? "FAILED"
              : "UNKNOWN";
        return {
          status: mapped,
          attemptId: existingAttempt.id,
          paymentId: payment.id,
          declineCode: existingAttempt.failureCode ?? undefined,
          declineMessage:
            (existingAttempt.error as Record<string, unknown> | null)?.message as string | undefined,
        };
      }

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
      let attempt;
      try {
        attempt = await createPaymentAttempt(
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
      } catch (err: unknown) {
        // Concurrent racer already inserted the same idempotency key: return the
        // existing row instead of double-charging. Unique violations surface as
        // Postgres 23505 (or Drizzle wrapped equivalents containing "unique").
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: unknown })?.code;
        const isUniqueViolation =
          code === "23505" ||
          msg.toLowerCase().includes("unique") ||
          msg.toLowerCase().includes("duplicate") ||
          msg.includes("payment_attempts_idempotency_key_unique") ||
          msg.includes("payment_attempts_payment_attempt_number_unique");
        if (!isUniqueViolation) throw err;
        const winner = await findPaymentAttemptByIdempotencyKey(
          { db, tx },
          { tenantId: input.tenantId, idempotencyKey },
        );
        if (!winner) throw err;
        const mapped: "SUCCEEDED" | "FAILED" | "UNKNOWN" =
          winner.status === "SUCCEEDED"
            ? "SUCCEEDED"
            : winner.status === "FAILED"
              ? "FAILED"
              : "UNKNOWN";
        return {
          status: mapped,
          attemptId: winner.id,
          paymentId: payment.id,
          declineCode: winner.failureCode ?? undefined,
          declineMessage:
            (winner.error as Record<string, unknown> | null)?.message as string | undefined,
        };
      }

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
