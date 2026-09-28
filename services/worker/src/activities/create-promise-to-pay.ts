import { createPromiseToPay } from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
} from "../framework";

export interface CreatePromiseToPayActivityInput extends ActivityContext {
  promisedAmountMinor: string | number;
  currency: string;
  // Optional: when omitted (customer reply without a date), the activity defaults
  // deterministically to +7d from activity time (activities may use Date.now;
  // workflows must NOT — see invoice-overdue.ts audit fix).
  promisedByDate?: string; // YYYY-MM-DD
  gracePeriodHours?: number; // default 24h
}

export interface CreatePromiseToPayActivityResult {
  promiseId: string;
  status: string;
  promisedByDate: string;
  caseId: string;
  // Deterministic wait computed from promised_by_date + grace (audit s-24 fix):
  // duration until due-end-of-day + grace, clamped to >=1s. Workflows must wait
  // this delay instead of fixed metadata.ptpWaitDelay.
  waitDelay: string;
  waitDelayMs: number;
  computedDefaultDate: boolean;
}

/**
 * Computes Temporal wait duration from promised date + grace.
 * Due is interpreted as end of the promised UTC day + grace hours.
 */
export function computePtpWaitDelay(
  promisedByDate: string,
  now: Date,
  gracePeriodHours = 24,
): { waitDelay: string; waitDelayMs: number } {
  const dueEndOfDay = new Date(`${promisedByDate}T23:59:59.999Z`);
  const dueTime = Number.isNaN(dueEndOfDay.getTime())
    ? now.getTime() + 7 * 86400000
    : dueEndOfDay.getTime();
  const target = dueTime + gracePeriodHours * 3600 * 1000;
  const diffMs = target - now.getTime();
  if (diffMs <= 0) {
    return { waitDelay: "1s", waitDelayMs: 1000 };
  }
  const diffSec = Math.ceil(diffMs / 1000);
  return { waitDelay: `${diffSec}s`, waitDelayMs: diffMs };
}

/**
 * Activity: createPromiseToPayActivity
 * Creates a new Promise to Pay record in MADE status (Step 24).
 * Supplies deterministic default date (+7d) and PTP wait delay when the
 * customer reply omits promisedByDate, so workflow bodies stay deterministic.
 */
export async function createPromiseToPayActivity(
  input: CreatePromiseToPayActivityInput,
): Promise<CreatePromiseToPayActivityResult> {
  return await withActivityContext("createPromiseToPay", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      const now = new Date();
      // Default promised date computed inside the activity (Date.now allowed here,
      // forbidden in workflow bodies). +7d from activity time, YYYY-MM-DD UTC.
      let resolvedDate = input.promisedByDate;
      let computedDefaultDate = false;
      if (!resolvedDate) {
        resolvedDate = new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10);
        computedDefaultDate = true;
      }
      const promisedAmount = BigInt(input.promisedAmountMinor);
      const created = await createPromiseToPay(
        { db, tx },
        {
          tenantId: input.tenantId,
          caseId: input.caseId,
          promisedAmount,
          currency: input.currency,
          promisedByDate: resolvedDate,
          status: "MADE",
        },
      );

      const { waitDelay, waitDelayMs } = computePtpWaitDelay(
        created.promisedByDate ?? resolvedDate,
        now,
        input.gracePeriodHours ?? 24,
      );

      return {
        promiseId: created.id,
        status: created.status,
        promisedByDate: created.promisedByDate,
        caseId: created.caseId,
        waitDelay,
        waitDelayMs,
        computedDefaultDate,
      };
    });
  });
}
