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
import { checkFaultPoint } from "@repo/worker/fault-points";
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
 * Narrow retry classifier (s-18 audit, Spec 18 §Requirements 4:
 * "retries ONLY for network-class errors ×2").
 *
 * Retryable: transport/network failures, timeouts/aborts, and provider 5xx
 * surfaced as thrown errors. NOT retryable: programming errors (TypeError,
 * RangeError, JSON bugs), validation errors, and definitive HTTP 4xx outcomes
 * (adapters already map 4xx to FAILED results instead of throwing).
 */
export function isRetryableProviderError(error: any): boolean {
  if (error === null || error === undefined) {
    return false;
  }
  if (typeof error === "string") {
    return /timeout|timed out|deadline|fetch failed|network|socket|ECONN|EAI_AGAIN|ETIMEDOUT/i.test(
      error,
    );
  }
  if (typeof error !== "object") {
    return false;
  }

  const message = String((error as any).message ?? "");
  const code = String(
    (error as any).code ?? (error as any)?.cause?.code ?? "",
  );
  const status =
    (error as any).status ?? (error as any).statusCode ?? (error as any)?.response?.status;
  const haystack = `${message} ${code}`;

  // Explicit transient markers set by adapters/tests.
  if ((error as any).retryable === true || (error as any).transient === true) {
    return true;
  }
  // Abort / timeout: adapter AbortController, 15s execution budget.
  if (
    (error as any).name === "AbortError" ||
    /abort|timeout|timed out|deadline exceeded|exceeded/i.test(haystack)
  ) {
    return true;
  }
  // Transport-level network failures (fetch TypeError, ECONN*, DNS, sockets).
  if (
    /fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|EHOST|socket hang up|connection reset|TLS|temporarily unavailable/i.test(
      haystack,
    )
  ) {
    return true;
  }
  // Provider 5xx thrown by adapters ("…returned 5xx status: 502", HTTP 5xx).
  if (typeof status === "number" && status >= 500 && status <= 599) {
    return true;
  }
  if (/\b5\d{2}\b/.test(message) && /5xx|HTTP|status/i.test(message)) {
    return true;
  }
  return false;
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
   * Waits for another execution's in-flight REQUESTED attempt to reach a
   * terminal state (s-18 double-charge fix). Polls 30×100ms; returns the
   * latest row (possibly still REQUESTED on timeout — callers must NOT
   * charge in that case, just report duplicate).
   */
  private async waitForAttemptResolution(tenantId: string, idempotencyKey: string) {
    let attempt = await this.repos.findPaymentAttemptByIdempotencyKey(
      { db: this.db },
      { tenantId, idempotencyKey },
    );
    for (let i = 0; i < 30 && (!attempt || attempt.status === "REQUESTED"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      attempt = await this.repos.findPaymentAttemptByIdempotencyKey(
        { db: this.db },
        { tenantId, idempotencyKey },
      );
    }
    return attempt;
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

        if (attempt && attempt.status === "REQUESTED") {
          // Two distinct situations share this observable state:
          // (a) Crash-resume adoption (actionId present): the previous
          //     execution died after inserting REQUESTED (e.g. SIGKILL in the
          //     claim→provider window) without charging. The resume must
          //     ADOPT the orphan and execute — exactly once, since the dead
          //     run never reached the provider. Fall through to claim+charge
          //     below (provider-level idempotency keys backstop the
          //     dead-after-charge window).
          // (b) Concurrent live race WITHOUT action context (s-18 fix): the
          //     winner is actively charging right now. Falling through would
          //     double-charge, so wait for the winner to resolve and report
          //     duplicate without touching the provider.
          if (!actionId) {
            attempt = await this.waitForAttemptResolution(tenantId, idempotencyKey);
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
          }
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
              attempt = await this.waitForAttemptResolution(tenantId, idempotencyKey);

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
          // Step 31: deterministic crash window between claim and provider call.
          await checkFaultPoint("claim", "after_claim", {
            tenantId,
            caseId,
            actionId,
            idempotencyKey,
          });
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

          // Step 31: crash window immediately before the money-moving call.
          await checkFaultPoint("claim", "before_provider_call", {
            tenantId,
            caseId,
            actionId,
            idempotencyKey,
          });

          adapterResult = await this.callAdapterWithNetworkRetries(
            adapter,
            providerCallInput,
            timeoutMs,
          );

          // Step 31: crash window after provider authorized, before ledger write.
          await checkFaultPoint("claim", "after_provider_call", {
            tenantId,
            caseId,
            actionId,
            idempotencyKey,
          });
        } catch (networkError: any) {
          // Step 31: injected crash faults must propagate (simulated SIGKILL),
          // never be misclassified as provider network UNKNOWN.
          if (networkError?.code === "FAULT_INJECTED") {
            throw networkError;
          }
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
   * s-18 audit: ONLY network/timeout/5xx errors (isRetryableProviderError)
   * are retried — programming errors surface immediately so bugs are loud
   * instead of burning retries and masking as UNKNOWN.
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
        if (!isRetryableProviderError(error)) {
          throw error;
        }
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
