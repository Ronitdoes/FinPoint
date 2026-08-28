import type { Database, Payment, PaymentAttempt } from "@repo/db";
import type { Repositories } from "../../plugins/db";
import type { ServerConfig } from "@repo/config";
import type { Provider } from "@repo/domain";
import {
  type PaymentProvider,
  type PaymentStatusResult,
  resolvePaymentProvider,
} from "@repo/integrations";
import { recordProviderCall, withSpan } from "@repo/observability";

export interface PollPaymentStatusOptions {
  tenantId: string;
  caseId?: string;
  paymentId: string;
  attemptId?: string;
  actionId?: string;
  provider: Provider | string;
  providerPaymentId: string;
  maxPolls?: number;
  initialIntervalMs?: number;
  backoffMultiplier?: number;
  customAdapter?: PaymentProvider;
}

/**
 * Payment Refresh Service (Spec 18 §Technical Implementation).
 * Handles polling getPaymentStatus for UNKNOWN and ACCEPTED_ASYNC payment attempts.
 */
export class PaymentRefreshService {
  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
    private readonly config?: ServerConfig,
    private readonly customAdapter?: PaymentProvider,
  ) {}

  /**
   * Polls getPaymentStatus up to N=6 times over a bounded schedule.
   * Final states are written to payments + payment_attempts tables.
   */
  async pollPaymentStatus(options: PollPaymentStatusOptions): Promise<PaymentStatusResult> {
    const {
      tenantId,
      caseId,
      paymentId,
      attemptId,
      actionId,
      provider,
      providerPaymentId,
      maxPolls = 6,
      initialIntervalMs = 500,
      backoffMultiplier = 1.5,
    } = options;

    const adapter =
      options.customAdapter ??
      this.customAdapter ??
      resolvePaymentProvider({
        provider: provider as Provider,
        paymentsConfig: this.config?.payments,
        demoConfig: this.config?.demo,
      });

    let currentInterval = initialIntervalMs;
    let lastResult: PaymentStatusResult = {
      id: providerPaymentId,
      status: "UNKNOWN",
    };

    return await withSpan(
      "payment.refresh_status",
      {
        "tenant.id": tenantId,
        "recovery.case_id": caseId,
        "payment.id": paymentId,
        "provider.name": provider,
      },
      async () => {
        for (let poll = 1; poll <= maxPolls; poll++) {
          const startTime = performance.now();
          try {
            lastResult = await adapter.getPaymentStatus(providerPaymentId);
            const latency = performance.now() - startTime;
            recordProviderCall(provider, "getPaymentStatus", "success", latency);

            if (lastResult.status === "SUCCEEDED") {
              const now = lastResult.paidAt ?? new Date();

              // Update payment
              await this.repos.updatePaymentStatus(
                { db: this.db },
                {
                  tenantId,
                  paymentId,
                  status: "SUCCEEDED",
                  paidAt: now,
                },
              );

              // Update payment attempt if specified
              if (attemptId) {
                await this.repos.resolvePaymentAttempt(
                  { db: this.db },
                  {
                    tenantId,
                    attemptId,
                    status: "SUCCEEDED",
                    providerReference: lastResult.providerReference || providerPaymentId,
                    resolvedAt: now,
                  },
                );
              }

              // Fee capture
              if (lastResult.fee && caseId) {
                await this.repos.recordCostEntry(
                  { db: this.db },
                  {
                    tenantId,
                    caseId,
                    category: "PAYMENT_PROCESSING",
                    amount: lastResult.fee.amount,
                    currency: lastResult.fee.currency,
                    metadata: {
                      provider,
                      providerPaymentId,
                      polled: true,
                      attemptId,
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
                      providerReference: lastResult.providerReference,
                      fee: lastResult.fee
                        ? {
                            amount: lastResult.fee.amount.toString(),
                            currency: lastResult.fee.currency,
                          }
                        : undefined,
                      polled: true,
                    },
                  },
                );
              }

              return lastResult;
            }

            if (lastResult.status === "FAILED") {
              const now = new Date();

              // Update payment
              await this.repos.updatePaymentStatus(
                { db: this.db },
                {
                  tenantId,
                  paymentId,
                  status: "FAILED",
                  failureCode: lastResult.failureCode,
                  failureMessage: lastResult.failureMessage,
                },
              );

              // Update attempt
              if (attemptId) {
                await this.repos.resolvePaymentAttempt(
                  { db: this.db },
                  {
                    tenantId,
                    attemptId,
                    status: "FAILED",
                    providerReference: lastResult.providerReference || providerPaymentId,
                    failureCode: lastResult.failureCode,
                    error: {
                      failureMessage: lastResult.failureMessage,
                      rawResponse: lastResult.rawResponse,
                    },
                    resolvedAt: now,
                  },
                );
              }

              // Fail action if present
              if (actionId) {
                await this.repos.failAction(
                  { db: this.db },
                  {
                    tenantId,
                    actionId,
                    error: {
                      failureCode: lastResult.failureCode,
                      failureMessage: lastResult.failureMessage,
                    },
                  },
                );
              }

              return lastResult;
            }
          } catch (err: any) {
            const latency = performance.now() - startTime;
            recordProviderCall(provider, "getPaymentStatus", "error", latency);
          }

          // If not terminal and not last poll, sleep before next retry
          if (poll < maxPolls) {
            await new Promise((resolve) => setTimeout(resolve, currentInterval));
            currentInterval = Math.round(currentInterval * backoffMultiplier);
          }
        }

        // Giving-up semantics (Spec 18 §Definition of Done & §Reliability):
        // If status remains UNKNOWN after maxPolls, leave in UNKNOWN state for s-31 sweeper
        return lastResult;
      },
    );
  }
}
