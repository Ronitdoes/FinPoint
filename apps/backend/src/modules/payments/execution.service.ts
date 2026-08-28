import type { Database, Payment, PaymentAttempt } from "@repo/db";
import { isUniqueViolation, EntityNotFoundError } from "@repo/db";
import type { Repositories } from "../../plugins/db";
import type { ServerConfig } from "@repo/config";
import type { Provider, PaymentAttemptInitiatedBy } from "@repo/domain";
import {
  type PaymentProvider,
  type RetryPaymentResult,
  type ProviderFee,
  resolvePaymentProvider,
} from "@repo/integrations";
import {
  recordProviderCall,
  recordProviderDecline,
  withSpan,
} from "@repo/observability";
import { PaymentRefreshService } from "./refresh.service";

export interface ExecuteRetryPaymentInput {
  tenantId: string;
  caseId: string;
  paymentId: string;
  attemptNumber: number;
  actionId?: string;
  initiatedBy?: PaymentAttemptInitiatedBy;
  amount?: bigint;
  currency?: string;
  customerId?: string;
  customerEmail?: string;
  paymentMethodId?: string;
  provider?: Provider | string;
  providerPaymentId?: string;
  metadata?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface ExecuteRetryPaymentResult {
  attempt: PaymentAttempt;
  payment: Payment;
  outcome: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "ACCEPTED_ASYNC";
  duplicate?: boolean;
  fee?: ProviderFee;
}

/**
 * Payment Execution Service (Spec 01 §14, §21, Spec 18 §Requirements 3).
 * Wraps payment provider adapter calls with idempotency verification,
 * guarded state updates, network retry policies, fee capture, and status polling.
 */
export class PaymentExecutionService {
  private readonly refreshService: PaymentRefreshService;

  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
    private readonly config?: ServerConfig,
    private readonly customAdapter?: PaymentProvider,
  ) {
    this.refreshService = new PaymentRefreshService(
      this.db,
      this.repos,
      this.config,
      this.customAdapter,
    );
  }

  /**
   * Generates the canonical idempotency key for financial payment retry actions.
   * Format: {tenant}:{case}:RETRY_PAYMENT:{attempt} (Spec 01 §21).
   */
  static deriveIdempotencyKey(
    tenantId: string,
    caseId: string,
    attemptNumber: number,
  ): string {
    return `${tenantId}:${caseId}:RETRY_PAYMENT:${attemptNumber}`;
  }

  /**
   * Executes an idempotency-safe payment retry against the configured provider.
   */
  async executeRetryPayment(
    input: ExecuteRetryPaymentInput,
  ): Promise<ExecuteRetryPaymentResult> {
    const {
      tenantId,
      caseId,
      paymentId,
      attemptNumber,
      actionId,
      initiatedBy = "RECOVERY_WORKFLOW",
      timeoutMs = 15000,
    } = input;

    const idempotencyKey = PaymentExecutionService.deriveIdempotencyKey(
      tenantId,
      caseId,
      attemptNumber,
    );

    return await withSpan(
      "payment.execute_retry",
      {
        "tenant.id": tenantId,
        "recovery.case_id": caseId,
        "recovery.action_id": actionId,
        "payment.id": paymentId,
        "payment.attempt_number": attemptNumber,
        "idempotency.key": idempotencyKey,
      },
      async () => {
        // 1. Check if an attempt row with this unique idempotency key already exists (Spec 01 §21)
        let attempt = await this.repos.findPaymentAttemptByIdempotencyKey(
          { db: this.db },
          { tenantId, idempotencyKey },
        );

        if (attempt && attempt.status !== "REQUESTED") {
          // Duplicate call detected: short-circuit and return existing outcome without hitting provider
          const payment = await this.repos.findPaymentById(
            { db: this.db },
            { tenantId, paymentId },
          );
          return {
            attempt,
            payment: payment!,
            outcome: attempt.status as any,
            duplicate: true,
          };
        }

        // 2. Insert payment_attempts row REQUESTED if not existing
        if (!attempt) {
          try {
            attempt = await this.repos.createPaymentAttempt(
              { db: this.db },
              {
                tenantId,
                paymentId,
                attemptNumber,
                initiatedBy,
                idempotencyKey,
                status: "REQUESTED",
                requestedAt: new Date(),
              },
            );
          } catch (error) {
            if (isUniqueViolation(error)) {
              // Concurrency race: another worker created this attempt row and is executing the charge
              // Wait for the winning execution to resolve the attempt row
              for (let i = 0; i < 30; i++) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                attempt = await this.repos.findPaymentAttemptByIdempotencyKey(
                  { db: this.db },
                  { tenantId, idempotencyKey },
                );
                if (attempt && attempt.status !== "REQUESTED") {
                  const payment = await this.repos.findPaymentById(
                    { db: this.db },
                    { tenantId, paymentId },
                  );
                  return {
                    attempt,
                    payment: payment!,
                    outcome: attempt.status as any,
                    duplicate: true,
                  };
                }
              }

              // If still in-flight after poll limit, return existing attempt without double execution
              const payment = await this.repos.findPaymentById(
                { db: this.db },
                { tenantId, paymentId },
              );
              return {
                attempt: attempt!,
                payment: payment!,
                outcome: (attempt?.status || "UNKNOWN") as any,
                duplicate: true,
              };
            } else {
              throw error;
            }
          }
        }

        // 3. Claim action row (guarded conditional update) BEFORE provider call
        if (actionId) {
          await this.repos.claimActionForExecution(
            { db: this.db },
            { tenantId, actionId },
          );
        }

        // 4. Resolve payment details from database
        const payment = await this.repos.findPaymentById(
          { db: this.db },
          { tenantId, paymentId },
        );
        if (!payment) {
          throw new EntityNotFoundError("Payment", paymentId);
        }

        const effectiveProvider = (input.provider || payment.provider) as Provider;
        const adapter =
          this.customAdapter ??
          resolvePaymentProvider({
            provider: effectiveProvider,
            paymentsConfig: this.config?.payments,
            demoConfig: this.config?.demo,
          });

        // 5. Call adapter with 15s timeout budget and network retry policy (2 retries, jittered backoff)
        const providerCallInput = {
          tenantId,
          caseId,
          paymentId,
          attemptNumber,
          idempotencyKey,
          amount: input.amount ?? payment.amount,
          currency: input.currency ?? payment.currency,
          providerPaymentId: input.providerPaymentId ?? payment.providerPaymentId,
          paymentMethodId: input.paymentMethodId,
          customerId: input.customerId ?? payment.customerId,
          customerEmail: input.customerEmail,
          metadata: input.metadata,
        };

        let adapterResult: RetryPaymentResult;
        const startTime = performance.now();

        try {
          // Check failure injection switch (Spec 03 §9)
          if (this.config?.demo?.simulatePaymentTimeout) {
            throw new Error("SIMULATE_PAYMENT_TIMEOUT triggered");
          }

          adapterResult = await this.callAdapterWithNetworkRetries(
            adapter,
            providerCallInput,
            timeoutMs,
          );
        } catch (networkError: any) {
          const latency = performance.now() - startTime;
          recordProviderCall(effectiveProvider, "retryPayment", "error", latency);

          // Timeout / network error resolves attempt to UNKNOWN and triggers status polling
          const resolvedAttempt = await this.repos.resolvePaymentAttempt(
            { db: this.db },
            {
              tenantId,
              attemptId: attempt.id,
              status: "UNKNOWN",
              error: {
                message: networkError.message || "Network error during payment retry",
              },
              resolvedAt: new Date(),
            },
          );

          // Asynchronously trigger refresh status polling in background
          this.refreshService.pollPaymentStatus({
            tenantId,
            caseId,
            paymentId,
            attemptId: attempt.id,
            actionId,
            provider: effectiveProvider,
            providerPaymentId: payment.providerPaymentId,
          }).catch(() => {
            // Background polling error caught safely
          });

          return {
            attempt: resolvedAttempt ?? attempt,
            payment,
            outcome: "UNKNOWN",
          };
        }

        const latency = performance.now() - startTime;

        // 6. Process definitive adapter outcomes
        if (adapterResult.status === "SUCCEEDED") {
          recordProviderCall(effectiveProvider, "retryPayment", "success", latency);
          const now = new Date();

          // Update attempt row to SUCCEEDED
          const resolvedAttempt = await this.repos.resolvePaymentAttempt(
            { db: this.db },
            {
              tenantId,
              attemptId: attempt.id,
              status: "SUCCEEDED",
              providerReference: adapterResult.providerReference || payment.providerPaymentId,
              resolvedAt: now,
            },
          );

          // Update payment record to SUCCEEDED
          const updatedPayment = await this.repos.updatePaymentStatus(
            { db: this.db },
            {
              tenantId,
              paymentId,
              status: "SUCCEEDED",
              paidAt: now,
            },
          );

          // Fee capture hook: write entry into recovery_cost_entries (Spec 02 §8, Spec 18 §Requirements 6)
          if (adapterResult.fee) {
            await this.repos.recordCostEntry(
              { db: this.db },
              {
                tenantId,
                caseId,
                category: "PAYMENT_PROCESSING",
                amount: adapterResult.fee.amount,
                currency: adapterResult.fee.currency,
                metadata: {
                  provider: effectiveProvider,
                  attemptNumber,
                  providerReference: adapterResult.providerReference,
                },
                incurredAt: now,
              },
            );
          }

          // Complete action if present
          if (actionId) {
            await this.repos.completeAction(
              { db: this.db },
              {
                tenantId,
                actionId,
                result: {
                  status: "SUCCEEDED",
                  providerReference: adapterResult.providerReference,
                  fee: adapterResult.fee
                    ? {
                        amount: adapterResult.fee.amount.toString(),
                        currency: adapterResult.fee.currency,
                      }
                    : undefined,
                },
              },
            );
          }

          return {
            attempt: resolvedAttempt ?? attempt,
            payment: updatedPayment ?? payment,
            outcome: "SUCCEEDED",
            fee: adapterResult.fee,
          };
        }

        if (adapterResult.status === "FAILED") {
          recordProviderCall(effectiveProvider, "retryPayment", "error", latency);
          recordProviderDecline(
            effectiveProvider,
            adapterResult.failureCode || "unknown_decline",
          );

          const now = new Date();

          // Update attempt row to FAILED
          const resolvedAttempt = await this.repos.resolvePaymentAttempt(
            { db: this.db },
            {
              tenantId,
              attemptId: attempt.id,
              status: "FAILED",
              providerReference: adapterResult.providerReference || payment.providerPaymentId,
              failureCode: adapterResult.failureCode,
              error: {
                rawFailureCode: adapterResult.rawFailureCode,
                failureMessage: adapterResult.failureMessage,
                rawResponse: adapterResult.rawResponse,
              },
              resolvedAt: now,
            },
          );

          // Update payment record to FAILED
          const updatedPayment = await this.repos.updatePaymentStatus(
            { db: this.db },
            {
              tenantId,
              paymentId,
              status: "FAILED",
              failureCode: adapterResult.failureCode,
              failureMessage: adapterResult.failureMessage,
            },
          );

          // Fail action if present
          if (actionId) {
            await this.repos.failAction(
              { db: this.db },
              {
                tenantId,
                actionId,
                error: {
                  failureCode: adapterResult.failureCode,
                  failureMessage: adapterResult.failureMessage,
                },
              },
            );
          }

          return {
            attempt: resolvedAttempt ?? attempt,
            payment: updatedPayment ?? payment,
            outcome: "FAILED",
          };
        }

        // ACCEPTED_ASYNC or UNKNOWN: trigger status refresh polling
        recordProviderCall(effectiveProvider, "retryPayment", "success", latency);

        const resolvedAttempt = await this.repos.resolvePaymentAttempt(
          { db: this.db },
          {
            tenantId,
            attemptId: attempt.id,
            status: "UNKNOWN",
            providerReference: adapterResult.providerReference || payment.providerPaymentId,
            error: {
              status: adapterResult.status,
              message: adapterResult.failureMessage || "Accepted asynchronously, awaiting resolution",
            },
          },
        );

        // Initiate background polling loop
        this.refreshService.pollPaymentStatus({
          tenantId,
          caseId,
          paymentId,
          attemptId: attempt.id,
          actionId,
          provider: effectiveProvider,
          providerPaymentId: adapterResult.providerReference || payment.providerPaymentId,
        }).catch(() => {});

        return {
          attempt: resolvedAttempt ?? attempt,
          payment,
          outcome: adapterResult.status,
        };
      },
    );
  }

  /**
   * Helper that executes the adapter call with bounded network-only retries (2 retries max).
   * HTTP 4xx errors from provider are definitive outcomes and NOT retried.
   */
  private async callAdapterWithNetworkRetries(
    adapter: PaymentProvider,
    input: any,
    timeoutMs: number,
  ): Promise<RetryPaymentResult> {
    const maxRetries = 2;
    let attempt = 0;

    while (true) {
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Provider call timeout exceeded")), timeoutMs),
        );

        return await Promise.race([
          adapter.retryPayment(input),
          timeoutPromise,
        ]);
      } catch (error: any) {
        attempt++;
        if (attempt > maxRetries) {
          throw error;
        }

        // Exponential backoff with full jitter (1s base, 2s max)
        const baseDelay = Math.min(1000 * Math.pow(2, attempt - 1), 2000);
        const jitter = Math.random() * baseDelay;
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }
    }
  }
}
