import {
  findCaseById,
  findRevenueRiskById,
  findCustomerById,
  listActionsForCase,
  type RecoveryCase,
  type RevenueRisk,
  type Customer,
  type RecoveryAction,
} from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
  createNonRetryableFailure,
} from "../framework";

export type LoadCaseSnapshotInput = ActivityContext;

export interface CaseSnapshot {
  case: RecoveryCase;
  risk: RevenueRisk | null;
  customer: Customer | null;
  actions: RecoveryAction[];
}

/**
 * Activity: loadCaseSnapshot
 * Loads a point-in-time snapshot of the case, related risk, customer, and planned actions.
 */
export async function loadCaseSnapshot(
  input: LoadCaseSnapshotInput,
): Promise<CaseSnapshot> {
  return await withActivityContext("loadCaseSnapshot", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const caseRecord = await findCaseById(
        { db, tx },
        { tenantId: input.tenantId, caseId: input.caseId },
      );

      if (!caseRecord) {
        throw createNonRetryableFailure(
          `Case '${input.caseId}' not found for tenant '${input.tenantId}'`,
          "ENTITY_NOT_FOUND",
        );
      }

      let risk: RevenueRisk | null = null;
      if (caseRecord.riskId) {
        risk = await findRevenueRiskById(
          { db, tx },
          { tenantId: input.tenantId, riskId: caseRecord.riskId },
        );
      }

      const customer = await findCustomerById(
        { db, tx },
        { tenantId: input.tenantId, customerId: caseRecord.customerId },
      );

      const actions = await listActionsForCase(
        { db, tx },
        { tenantId: input.tenantId, caseId: input.caseId },
      );

      return {
        case: caseRecord,
        risk,
        customer,
        actions,
      };
    });
  });
}
