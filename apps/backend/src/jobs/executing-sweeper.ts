import type { Database } from "@repo/db";
import type { Repositories } from "../plugins/db";
import type { ServerConfig } from "@repo/config";
import {
  resolvePaymentProvider,
  type PaymentProvider,
  type PaymentStatusResult,
} from "@repo/integrations";
import {
  getLogger,
  recordExecutingSweeperAction,
} from "@repo/observability";

const logger = getLogger({ component: "executing-sweeper" });

/** Default age after which an EXECUTING action counts as stuck (5 minutes). */
export const EXECUTING_STUCK_SECONDS_DEFAULT = 300;
/** Default batch size per sweep pass. */
export const EXECUTING_SWEEP_BATCH_DEFAULT = 100;

export interface ExecutingSweepOptions {
  tenantId?: string;
  /** Age threshold in seconds (default 300). */
  stuckSeconds?: number;
  batchSize?: number;
  /**
   * Injected status-query function (tests). Defaults to resolving the live
   * provider adapter and calling `getPaymentStatus` — a read-only status
   * query, NEVER a re-execution.
   */
  statusResolver?: (input: {
    tenantId: string;
    provider: string;
    statusQueryId: string;
  }) => Promise<PaymentStatusResult>;
}

export interface ExecutingSweepResult {
  actionsAudited: number;
  actionsCompleted: number;
  actionsFailed: number;
  stillPending: number;
  sweptActionIds: string[];
}

const RETRY_PAYMENT_TYPES = new Set(["RETRY_PAYMENT"]);
const SEND_MESSAGE_TYPES = new Set(["SEND_WHATSAPP", "SEND_EMAIL", "SEND_SMS"]);

function isTerminalProviderStatus(status: string): boolean {
  return status === "SUCCEEDED" || status === "FAILED";
}

/**
 * EXECUTING-stuck sweeper (Step 31 §Requirements 4).
 *
 * Reconciliation job for actions claimed but never completed (crash window
 * between claim and completion): resolves each stuck row via provider status
 * query and completes/fails the guarded action row accordingly.
 *
 * Invariants:
 * - NEVER blindly re-executes: no adapter charge/send call is ever issued here.
 * - Every mutation uses the guarded conditional writes (`completeAction` /
 *   `failAction` only transition from EXECUTING), so a resumed worker racing
 *   the sweeper cannot double-apply.
 */
export class ExecutingSweeper {
  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
    private readonly config?: ServerConfig,
    private readonly customAdapter?: PaymentProvider,
  ) {}

  public async runSweep(
    options: ExecutingSweepOptions = {},
  ): Promise<ExecutingSweepResult> {
    const {
      tenantId,
      stuckSeconds = EXECUTING_STUCK_SECONDS_DEFAULT,
      batchSize = EXECUTING_SWEEP_BATCH_DEFAULT,
      statusResolver,
    } = options;

    const stuckBefore = new Date(Date.now() - stuckSeconds * 1000);
    logger.info({ tenantId, stuckSeconds, batchSize }, "Starting EXECUTING-stuck sweep");

    const stuck = await this.repos.findStuckExecutingActions(
      { db: this.db },
      { tenantId, stuckBefore, limit: batchSize },
    );

    const result: ExecutingSweepResult = {
      actionsAudited: stuck.length,
      actionsCompleted: 0,
      actionsFailed: 0,
      stillPending: 0,
      sweptActionIds: [],
    };

    for (const action of stuck) {
      try {
        const outcome = await this.reconcileAction(action, statusResolver);
        if (outcome === "completed") {
          result.actionsCompleted++;
          result.sweptActionIds.push(action.id);
          recordExecutingSweeperAction("completed");
        } else if (outcome === "failed") {
          result.actionsFailed++;
          result.sweptActionIds.push(action.id);
          recordExecutingSweeperAction("failed");
        } else {
          result.stillPending++;
          recordExecutingSweeperAction("pending");
        }
      } catch (err: any) {
        logger.error(
          {
            err: err?.message,
            tenantId: action.tenantId,
            actionId: action.id,
            actionType: action.type,
          },
          "Failed to reconcile stuck EXECUTING action",
        );
        result.stillPending++;
        recordExecutingSweeperAction("pending");
      }
    }

    logger.info(
      {
        actionsAudited: result.actionsAudited,
        actionsCompleted: result.actionsCompleted,
        actionsFailed: result.actionsFailed,
        stillPending: result.stillPending,
      },
      "EXECUTING-stuck sweep completed",
    );

    return result;
  }

  private async reconcileAction(
    action: {
      id: string;
      tenantId: string;
      caseId: string;
      type: string;
      idempotencyKey: string;
      parameters?: unknown;
    },
    statusResolver?: ExecutingSweepOptions["statusResolver"],
  ): Promise<"completed" | "failed" | "pending"> {
    const { tenantId } = action;

    if (RETRY_PAYMENT_TYPES.has(action.type)) {
      return await this.reconcileRetryPayment(action, statusResolver);
    }

    if (SEND_MESSAGE_TYPES.has(action.type)) {
      return await this.reconcileSendMessage(action);
    }

    // Unknown action type: do NOT guess. Leave for operator triage; the row
    // stays EXECUTING and will be re-audited on the next pass.
    logger.warn(
      { tenantId, actionId: action.id, actionType: action.type },
      "executing-sweeper: unknown action type, leaving row untouched",
    );
    return "pending";
  }

  private async reconcileRetryPayment(
    action: { id: string; tenantId: string; caseId: string; idempotencyKey: string },
    statusResolver?: ExecutingSweepOptions["statusResolver"],
  ): Promise<"completed" | "failed" | "pending"> {
    const { tenantId } = action;

    // 1. Find the linked attempt row via the canonical idempotency key.
    const attempt = await this.repos.findPaymentAttemptByIdempotencyKey(
      { db: this.db },
      { tenantId, idempotencyKey: action.idempotencyKey },
    );

    if (!attempt) {
      // Crash landed between claim and attempt insert: the provider was never
      // called (claim precedes the call), so failing the action is safe and
      // the workflow may start a fresh attempt with a new key.
      await this.repos.failAction(
        { db: this.db },
        {
          tenantId,
          actionId: action.id,
          error: {
            code: "SWEEPER_ORPHAN_CLAIM",
            message:
              "Action stuck in EXECUTING with no attempt row; provider was never called (claim precedes provider call). Safe to retry with a new attempt.",
          },
        },
      );
      logger.warn(
        { tenantId, actionId: action.id },
        "executing-sweeper: orphan claim failed safely (no provider call made)",
      );
      return "failed";
    }

    if (attempt.status === "SUCCEEDED") {
      await this.repos.completeAction(
        { db: this.db },
        {
          tenantId,
          actionId: action.id,
          result: {
            attemptId: attempt.id,
            status: "SUCCEEDED",
            reconciledBy: "executing-sweeper",
          },
        },
      );
      return "completed";
    }

    if (attempt.status === "FAILED") {
      await this.repos.failAction(
        { db: this.db },
        {
          tenantId,
          actionId: action.id,
          error: {
            attemptId: attempt.id,
            failureCode: attempt.failureCode,
            reconciledBy: "executing-sweeper",
          },
        },
      );
      return "failed";
    }

    // 2. Attempt is REQUESTED or UNKNOWN: query provider status (read-only).
    const payment = await this.repos.findPaymentById(
      { db: this.db },
      { tenantId, paymentId: attempt.paymentId },
    );
    if (!payment) {
      logger.warn(
        { tenantId, actionId: action.id, paymentId: attempt.paymentId },
        "executing-sweeper: payment row missing, leaving action pending",
      );
      return "pending";
    }

    const provider = (payment.provider ?? "mock").toLowerCase();
    const statusQueryId =
      attempt.providerReference ?? payment.providerPaymentId ?? payment.id;

    let providerStatus: PaymentStatusResult;
    try {
      if (statusResolver) {
        providerStatus = await statusResolver({
          tenantId,
          provider,
          statusQueryId,
        });
      } else {
        const adapter =
          this.customAdapter ??
          resolvePaymentProvider({
            provider,
            paymentsConfig: this.config?.payments,
            demoConfig: this.config?.demo,
          });
        providerStatus = await adapter.getPaymentStatus(statusQueryId);
      }
    } catch (err: any) {
      // Status query itself failed (provider down): leave pending for retry.
      logger.warn(
        { tenantId, actionId: action.id, err: err?.message },
        "executing-sweeper: provider status query failed, leaving action pending",
      );
      return "pending";
    }

    if (providerStatus.status === "SUCCEEDED") {
      const now = new Date();
      await this.repos.resolvePaymentAttempt(
        { db: this.db },
        {
          tenantId,
          attemptId: attempt.id,
          status: "SUCCEEDED",
          providerReference: providerStatus.providerReference,
          resolvedAt: now,
        },
      );
      await this.repos.updatePaymentStatus(
        { db: this.db },
        { tenantId, paymentId: payment.id, status: "SUCCEEDED", paidAt: now },
      );
      await this.repos.completeAction(
        { db: this.db },
        {
          tenantId,
          actionId: action.id,
          result: {
            attemptId: attempt.id,
            status: "SUCCEEDED",
            reconciledBy: "executing-sweeper",
          },
        },
      );
      logger.info(
        { tenantId, actionId: action.id, paymentId: payment.id },
        "executing-sweeper: late provider success reconciled to EXECUTED",
      );
      return "completed";
    }

    if (providerStatus.status === "FAILED") {
      await this.repos.resolvePaymentAttempt(
        { db: this.db },
        {
          tenantId,
          attemptId: attempt.id,
          status: "FAILED",
          providerReference: providerStatus.providerReference,
          failureCode: providerStatus.failureCode,
          error: {
            failureMessage: providerStatus.failureMessage,
            reconciledBy: "executing-sweeper",
          },
          resolvedAt: new Date(),
        },
      );
      await this.repos.failAction(
        { db: this.db },
        {
          tenantId,
          actionId: action.id,
          error: {
            attemptId: attempt.id,
            failureCode: providerStatus.failureCode,
            failureMessage: providerStatus.failureMessage,
            reconciledBy: "executing-sweeper",
          },
        },
      );
      return "failed";
    }

    // Provider still UNKNOWN/PENDING/CREATED: not terminal — leave pending.
    // Terminal guard: never treat a non-terminal provider answer as failure.
    if (!isTerminalProviderStatus(providerStatus.status)) {
      logger.info(
        { tenantId, actionId: action.id, providerStatus: providerStatus.status },
        "executing-sweeper: provider status non-terminal, leaving action pending",
      );
      return "pending";
    }

    return "pending";
  }

  private async reconcileSendMessage(action: {
    id: string;
    tenantId: string;
    caseId: string;
    idempotencyKey: string;
  }): Promise<"completed" | "failed" | "pending"> {
    const { tenantId } = action;

    // Resolve via the delivery ledger (read-only): if the message row reached
    // a provider-acked status, the send happened exactly once — complete.
    const message = await this.repos.findMessageByIdempotencyKey(
      { db: this.db },
      { tenantId, idempotencyKey: action.idempotencyKey },
    );

    if (!message) {
      // Crash landed between claim and ledger insert: provider was never
      // called, so failing is safe (workflow may retry with a new key).
      await this.repos.failAction(
        { db: this.db },
        {
          tenantId,
          actionId: action.id,
          error: {
            code: "SWEEPER_ORPHAN_CLAIM",
            message:
              "Send action stuck in EXECUTING with no ledger row; provider was never called. Safe to retry with a new key.",
          },
        },
      );
      return "failed";
    }

    if (
      message.status === "SENT" ||
      message.status === "DELIVERED" ||
      message.status === "READ"
    ) {
      await this.repos.completeAction(
        { db: this.db },
        {
          tenantId,
          actionId: action.id,
          result: {
            messageId: message.id,
            status: message.status,
            reconciledBy: "executing-sweeper",
          },
        },
      );
      return "completed";
    }

    if (message.status === "FAILED" || message.status === "BOUNCED") {
      await this.repos.failAction(
        { db: this.db },
        {
          tenantId,
          actionId: action.id,
          error: {
            messageId: message.id,
            status: message.status,
            reconciledBy: "executing-sweeper",
          },
        },
      );
      return "failed";
    }

    // QUEUED: dispatch outcome genuinely unknown — leave pending.
    return "pending";
  }
}
