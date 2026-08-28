import type { Database, Tx } from "@repo/db";
import type { CaseStatus } from "@repo/domain";
import type { Repositories } from "../../plugins/db";
import { CaseNotFoundError, NotFoundError } from "../../lib/errors";
import { recordOutcomeRecorded, getLogger } from "@repo/observability";

const logger = getLogger({ component: "outcomes-record-service" });

export interface RecordOutcomeServiceInput {
  tenantId: string;
  caseId: string;
  paymentId: string;
  attributionMethod?: string;
  attributionWindowHours?: number;
  baselineAmount?: bigint;
  recoveredAmount?: bigint;
  recoveredAt?: Date;
  notes?: string;
}

export interface RecordOutcomeServiceResult {
  outcome: any;
  alreadyRecorded: boolean;
}

/**
 * OutcomeRecordService (Spec 01 §25, Spec 02 §8/§9, Step 26).
 * Single authoritative choke point for persisting financial outcomes, rolling up cost entries,
 * transitioning recovery cases, and logging timeline entries.
 */
export class OutcomeRecordService {
  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
  ) {}

  public async recordOutcome(
    input: RecordOutcomeServiceInput,
  ): Promise<RecordOutcomeServiceResult> {
    const { tenantId, caseId, paymentId } = input;

    // 1. Idempotency Check: if outcome already exists for case, return existing
    const existing = await this.repos.findOutcomeByCaseId(
      { db: this.db },
      { tenantId, caseId },
    );

    if (existing) {
      if (existing.paymentId !== paymentId) {
        logger.warn(
          {
            tenantId,
            caseId,
            existingPaymentId: existing.paymentId,
            competingPaymentId: paymentId,
          },
          "outcome.superseded_payment: competing payment arrived for case with existing outcome",
        );
      }
      return { outcome: existing, alreadyRecorded: true };
    }

    // 2. Execute authoritative outcome persistence inside database transaction
    return await this.repos.withTransaction({ db: this.db }, async (tx: Tx) => {
      // Re-check existing in tx (concurrency race protection)
      const existingInTx = await this.repos.findOutcomeByCaseId(
        { tx },
        { tenantId, caseId },
      );
      if (existingInTx) {
        if (existingInTx.paymentId !== paymentId) {
          logger.warn(
            {
              tenantId,
              caseId,
              existingPaymentId: existingInTx.paymentId,
              competingPaymentId: paymentId,
            },
            "outcome.superseded_payment: competing payment arrived in concurrent transaction",
          );
        }
        return { outcome: existingInTx, alreadyRecorded: true };
      }

      // Load Case Record
      const caseRecord = await this.repos.findCaseById(
        { tx },
        { tenantId, caseId },
      );
      if (!caseRecord) {
        throw new CaseNotFoundError(`Recovery case '${caseId}' not found`);
      }

      // Load Payment Record
      const paymentRecord = await this.repos.findPaymentById(
        { tx },
        { tenantId, paymentId },
      );
      if (!paymentRecord) {
        throw new NotFoundError(`Payment '${paymentId}' not found`);
      }

      // Compute Recovery Cost Rollup from recovery_cost_entries (Spec 02 §8)
      const recoveryCost = await this.repos.getRecoveryCostSumForCase(
        { tx },
        { tenantId, caseId },
      );

      const baselineAmount = input.baselineAmount ?? caseRecord.amountAtRisk;
      const recoveredAmount = input.recoveredAmount ?? paymentRecord.amount;
      const attributionMethod = input.attributionMethod ?? "WORKFLOW_LINKED";
      const attributionWindowHours =
        input.attributionWindowHours ?? caseRecord.attributionWindowHours ?? 72;
      const recoveredAt =
        input.recoveredAt ??
        paymentRecord.occurredAt ??
        paymentRecord.paidAt ??
        new Date();
      const recordedAt = new Date();

      // Insert Recovery Outcome
      const outcome = await this.repos.recordOutcomeInTx(tx, {
        tenantId,
        caseId,
        paymentId,
        baselineAmount,
        recoveredAmount,
        recoveryCost,
        attributionMethod,
        attributionWindowHours,
        recoveredAt,
        recordedAt,
      });

      // State Transition:
      // Non-terminal cases transition -> RECOVERED
      // Terminal cases (such as STOPPED or FAILED) remain STOPPED/FAILED (Step 26 §State Transitions)
      const nonTerminalStatuses: CaseStatus[] = [
        "DETECTED",
        "QUALIFIED",
        "DECISION_PENDING",
        "POLICY_REVIEW",
        "IN_PROGRESS",
        "WAITING",
        "ESCALATED",
      ];

      if (nonTerminalStatuses.includes(caseRecord.status as CaseStatus)) {
        await this.repos.transitionCaseStatus(
          { tx },
          {
            tenantId,
            caseId,
            from: [...nonTerminalStatuses],
            to: "RECOVERED",
            reason: "RECOVERED_AUTHORITATIVE",
            closedAt: recordedAt,
          },
        );
      }

      // Complete active workflow if present
      const workflow = await this.repos.findWorkflowByCaseId(
        { tx },
        { tenantId, caseId },
      );
      if (workflow && workflow.status === "RUNNING") {
        await this.repos.updateWorkflowStatus(
          { tx },
          {
            tenantId,
            workflowId: workflow.id,
            status: "COMPLETED",
            closedAt: recordedAt,
          },
        );
      }

      // Calculate net for timeline log
      const netRecovered =
        outcome.netRecovered !== null && outcome.netRecovered !== undefined
          ? outcome.netRecovered
          : recoveredAmount - recoveryCost;

      // Persist Timeline Event
      await this.repos.recordCaseEvent(
        { tx },
        {
          tenantId,
          caseId,
          eventType: "RECOVERY_RECORDED",
          actorType: "SYSTEM",
          description: `Recovery outcome recorded via ${attributionMethod} (Recovered: ${recoveredAmount}, Cost: ${recoveryCost}, Net: ${netRecovered})`,
          payload: {
            outcomeId: outcome.id,
            paymentId: outcome.paymentId,
            baselineAmount: outcome.baselineAmount.toString(),
            recoveredAmount: outcome.recoveredAmount.toString(),
            recoveryCost: outcome.recoveryCost.toString(),
            netRecovered: netRecovered.toString(),
            attributionMethod: outcome.attributionMethod,
            attributionWindowHours: outcome.attributionWindowHours,
            recoveredAt: outcome.recoveredAt.toISOString(),
            notes: input.notes,
          },
        },
      );

      // Increment metric
      recordOutcomeRecorded(attributionMethod);

      return { outcome, alreadyRecorded: false };
    });
  }
}
