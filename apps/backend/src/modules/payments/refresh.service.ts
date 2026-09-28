import type { Database, Payment, PaymentAttempt } from "@repo/db";
import { withTransaction } from "@repo/db";
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
  /**
   * Explicit per-poll settle delays (s-18 audit). Entry i is slept BEFORE
   * poll i+1: schedule[0] is the initial settle delay, the rest are the gaps
   * between polls. Defaults to DEFAULT_POLL_INTERVALS_MS (≈60s span).
   * When initialIntervalMs/backoffMultiplier are explicitly provided, the
   * legacy immediate-first-poll exponential schedule is used instead
   * (lets tests tune fast polling without waiting the production span).
   */
  pollIntervalsMs?: number[];
  customAdapter?: PaymentProvider;
}

/**
 * Default UNKNOWN-poll schedule: N=6 polls spread over a ~60s span
 * (Spec 18 §Requirements 5). 5s initial settle + 8/10/12/12/13s gaps.
 */
export const DEFAULT_POLL_INTERVALS_MS = [5_000, 8_000, 10_000, 12_000, 12_000, 13_000];

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
   * Polls getPaymentStatus up to N=6 times over a ~60s span (Spec 18 §Requirements 5).
   * Final states are written to payments + payment_attempts tables.
   * Giving-up semantics: if the provider never leaves PENDING/UNKNOWN after
   * maxPolls, the last result is returned WITHOUT marking the attempt failed —
   * the row stays UNKNOWN for the s-31 sweeper / webhook resolution.
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

    // s-18 audit: default schedule spreads N=6 polls over ~60s (was 500ms
    // ×1.5 ≈ 6.6s total, violating "N=6 over 60s"). Explicit
    // initialIntervalMs/backoffMultiplier keep the legacy immediate-first-poll
    // exponential behavior for tuned callers (tests, fast paths).
    const legacyTuning =
      options.initialIntervalMs !== undefined ||
      options.backoffMultiplier !== undefined;
    const schedule =
      options.pollIntervalsMs ??
      (legacyTuning ? undefined : DEFAULT_POLL_INTERVALS_MS);

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
          // Schedule-mode settle delay before each poll: schedule[0] settles
          // the provider before the first check, the rest gap the polls, so
          // N=6 polls span ≈60s (5+8+10+12+12+13). Legacy mode polls
          // immediately and sleeps after (below).
          if (schedule) {
            const settleMs =
              schedule[Math.min(poll - 1, schedule.length - 1)] ?? 0;
            if (settleMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, settleMs));
            }
          }

          const startTime = performance.now();
          try {
            lastResult = await adapter.getPaymentStatus(providerPaymentId);
            const latency = performance.now() - startTime;
            recordProviderCall(provider, "getPaymentStatus", "success", latency);

            if (lastResult.status === "SUCCEEDED") {
              const now = lastResult.paidAt ?? new Date();

              // Atomic terminal write (s-18 fix): payment + attempt + cost +
              // action complete in ONE transaction so a mid-branch failure can
              // never leave attempt-SUCCEEDED/action-EXECUTING partial state.
              await withTransaction({ db: this.db }, async (tx) => {
                const txCtx = { tx };
                // Update payment
                await this.repos.updatePaymentStatus(
                  txCtx,
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
                    txCtx,
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
                    txCtx,
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
                    txCtx,
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
              });

              return lastResult;
            }

            if (lastResult.status === "FAILED") {
              const now = new Date();

              // Atomic terminal write (s-18 fix): same rationale as SUCCEEDED
              // above — payment + attempt + action fail in ONE transaction.
              await withTransaction({ db: this.db }, async (tx) => {
                const txCtx = { tx };
                // Update payment
                await this.repos.updatePaymentStatus(
                  txCtx,
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
                    txCtx,
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
                    txCtx,
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
              });

              return lastResult;
            }
          } catch (err: any) {
            const latency = performance.now() - startTime;
            recordProviderCall(provider, "getPaymentStatus", "error", latency);
          }

          // If not terminal and not last poll, sleep before next retry.
          // Schedule mode already slept before this poll, so only the legacy
          // exponential path sleeps here.
          if (!schedule && poll < maxPolls) {
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
