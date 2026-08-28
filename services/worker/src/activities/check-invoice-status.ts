import { findInvoiceById, findCaseById } from "@repo/db";
import {
  type ActivityContext,
  withActivityContext,
  withActivityDb,
  createNonRetryableFailure,
} from "../framework";

export interface CheckInvoiceStatusInput extends ActivityContext {
  invoiceId?: string;
}

export interface CheckInvoiceStatusResult {
  exists: boolean;
  status: string;
  isPaid: boolean;
  isDisputed: boolean;
  amount: string;
  amountPaid: string;
  currency: string;
  paidAt?: string;
  disputedAt?: string;
  customerId?: string;
}

/**
 * Activity: checkInvoiceStatus
 * Loads fresh invoice state from the database to check if payment settled,
 * dispute was opened, or invoice is still overdue (Step 24).
 */
export async function checkInvoiceStatus(
  input: CheckInvoiceStatusInput,
): Promise<CheckInvoiceStatusResult> {
  return await withActivityContext("checkInvoiceStatus", input, async () => {
    return await withActivityDb(input, async (db, tx) => {
      let invoiceId = input.invoiceId;

      if (!invoiceId) {
        const caseRecord = await findCaseById(
          { db, tx },
          { tenantId: input.tenantId, caseId: input.caseId },
        );
        if (caseRecord && caseRecord.sourceEntityType === "INVOICE") {
          invoiceId = caseRecord.sourceEntityId;
        }
      }

      if (!invoiceId) {
        throw createNonRetryableFailure(
          `Unable to resolve invoice ID for case '${input.caseId}'`,
          "INVOICE_NOT_FOUND",
        );
      }

      const invoice = await findInvoiceById(
        { db, tx },
        { tenantId: input.tenantId, invoiceId },
      );

      if (!invoice) {
        return {
          exists: false,
          status: "UNKNOWN",
          isPaid: false,
          isDisputed: false,
          amount: "0",
          amountPaid: "0",
          currency: "INR",
        };
      }

      const isPaid = invoice.status === "PAID" || invoice.paidAt !== null;
      const isDisputed = invoice.status === "DISPUTED" || invoice.disputedAt !== null;

      return {
        exists: true,
        status: invoice.status,
        isPaid,
        isDisputed,
        amount: invoice.amount.toString(),
        amountPaid: invoice.amountPaid.toString(),
        currency: invoice.currency,
        paidAt: invoice.paidAt?.toISOString(),
        disputedAt: invoice.disputedAt?.toISOString(),
        customerId: invoice.customerId,
      };
    });
  });
}
