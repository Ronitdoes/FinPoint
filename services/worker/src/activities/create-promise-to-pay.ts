import { createPromiseToPay } from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
} from "../framework";

export interface CreatePromiseToPayActivityInput extends ActivityContext {
  promisedAmountMinor: string | number;
  currency: string;
  promisedByDate: string; // YYYY-MM-DD
}

export interface CreatePromiseToPayActivityResult {
  promiseId: string;
  status: string;
  promisedByDate: string;
  caseId: string;
}

/**
 * Activity: createPromiseToPayActivity
 * Creates a new Promise to Pay record in MADE status (Step 24).
 */
export async function createPromiseToPayActivity(
  input: CreatePromiseToPayActivityInput,
): Promise<CreatePromiseToPayActivityResult> {
  return await withActivityContext("createPromiseToPay", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const promisedAmount = BigInt(input.promisedAmountMinor);
      const created = await createPromiseToPay(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          promisedAmount,
          currency: input.currency,
          promisedByDate: input.promisedByDate,
          status: "MADE",
        },
      );

      return {
        promiseId: created.id,
        status: created.status,
        promisedByDate: created.promisedByDate,
        caseId: created.caseId,
      };
    });
  });
}
