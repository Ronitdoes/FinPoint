import { randomUUID } from "node:crypto";
import {
  recordOutcome as dbRecordOutcome,
  transitionCaseStatus,
  updateWorkflowStatus,
  findWorkflowByCaseId,
  findCaseById,
  findPaymentById,
  createPayment,
  recordCaseEvent,
  getRecoveryCostSumForCase,
} from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
} from "../framework";

export interface RecordOutcomeInput extends ActivityContext {
  outcome: "RECOVERED" | "UNRECOVERED" | "STOPPED" | "EXPIRED";
  recoveredAmountMinor?: string | bigint;
  currency?: string;
  paymentId?: string;
  checkoutId?: string;
  invoiceId?: string;
  recoverySource?: string;
  notes?: string;
}

export interface RecordOutcomeResult {
  outcomeId: string;
  outcome: string;
  resolvedAt: string;
}

/**
 * Activity: recordOutcome
 * Authoritatively persists the case recovery outcome in the ledger, resolves the case,
 * and completes the workflow record (Spec 01 §25, Spec 20 §Requirements 6, Spec 26).
 */
export async function recordOutcome(
  input: RecordOutcomeInput,
): Promise<RecordOutcomeResult> {
  return await withActivityContext("recordOutcome", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const recoveredAmount = input.recoveredAmountMinor
        ? BigInt(input.recoveredAmountMinor)
        : BigInt(0);
      const currency = input.currency ?? "INR";
      const now = new Date();

      const caseRecord = await findCaseById(
        { db, tx },
        { tenantId: input.tenantId, caseId: input.caseId },
      );

      let paymentId = input.paymentId;
      if (!paymentId) {
        if (caseRecord && caseRecord.sourceEntityType === "PAYMENT") {
          const existingPayment = await findPaymentById(
            { db, tx },
            { tenantId: input.tenantId, paymentId: caseRecord.sourceEntityId },
          );
          if (existingPayment) {
            paymentId = existingPayment.id;
          }
        }
        if (!paymentId) {
          const payment = await createPayment(
            { db, tx },
            {
              tenantId: input.tenantId,
              customerId: caseRecord?.customerId ?? randomUUID(),
              amount: recoveredAmount,
              currency,
              provider: "MOCK",
              providerPaymentId: `mock_${randomUUID()}`,
              status: "SUCCEEDED",
              occurredAt: now,
            },
          );
          paymentId = payment.id;
        }
      }

      // Roll up total recovery costs for case
      const recoveryCost = await getRecoveryCostSumForCase(
        { db, tx },
        { tenantId: input.tenantId, caseId: input.caseId },
      );

      // 1. Create recovery outcome ledger entry
      const outcomeRecord = await dbRecordOutcome(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          paymentId,
          baselineAmount: recoveredAmount,
          recoveredAmount,
          recoveryCost,
          attributionMethod: "WORKFLOW_LINKED",
          attributionWindowHours: caseRecord?.attributionWindowHours ?? 72,
          recoveredAt: now,
          recordedAt: now,
        },
      );

      const terminalStatus: "RECOVERED" | "STOPPED" | "FAILED" =
        input.outcome === "RECOVERED"
          ? "RECOVERED"
          : input.outcome === "STOPPED"
            ? "STOPPED"
            : "FAILED";

      await transitionCaseStatus(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          from: [
            "DETECTED",
            "QUALIFIED",
            "DECISION_PENDING",
            "POLICY_REVIEW",
            "IN_PROGRESS",
            "WAITING",
          ],
          to: terminalStatus,
          closedAt: now,
          reason: input.outcome === "STOPPED" ? "RECOVERY_UNSUCCESSFUL" : undefined,
        },
      );

      // 3. Mark workflow completed
      const workflow = await findWorkflowByCaseId(
        { db, tx },
        { tenantId: input.tenantId, caseId: input.caseId },
      );

      if (workflow) {
        await updateWorkflowStatus(
          { db, tx },
          {
            tenantId: input.tenantId,
            workflowId: workflow.id,
            status: "COMPLETED",
            closedAt: now,
          },
        );
      }

      // 4. Record timeline event
      await recordCaseEvent(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          eventType: "OUTCOME_RECORDED",
          actorType: "SYSTEM",
          description: `Outcome recorded: ${input.outcome}`,
          payload: {
            outcomeId: outcomeRecord.id,
            outcome: input.outcome,
            recoveredAmount: recoveredAmount.toString(),
            currency,
          },
        },
      );

      return {
        outcomeId: outcomeRecord.id,
        outcome: input.outcome,
        resolvedAt: now.toISOString(),
      };
    });
  });
}
