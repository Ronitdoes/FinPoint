import type { Database, PromiseToPay } from "@repo/db";
import type { Repositories } from "../../plugins/db";
import { NotFoundError, ConflictError } from "../../lib/errors";
import type { ListPromisesToPayQuery, MarkPromiseHonoredBody } from "./types";

export interface PromiseToPayResponse {
  id: string;
  tenant_id: string;
  case_id: string;
  promised_amount: string;
  currency: string;
  promised_by_date: string;
  status: string;
  honored_payment_id: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export function toPromiseToPayResponse(row: PromiseToPay): PromiseToPayResponse {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    case_id: row.caseId,
    promised_amount: row.promisedAmount.toString(),
    currency: row.currency,
    promised_by_date: row.promisedByDate,
    status: row.status,
    honored_payment_id: row.honoredPaymentId ?? null,
    resolved_at: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export class PromisesToPayService {
  constructor(
    private readonly db: Database,
    private readonly repos: Repositories,
  ) {}

  public async listPromises(
    tenantId: string,
    query: ListPromisesToPayQuery,
  ): Promise<{ data: PromiseToPayResponse[]; total: number }> {
    const promises = await this.repos.listPromisesToPay(
      { db: this.db },
      {
        tenantId,
        status: query.status as any,
        customerId: query.customer_id,
        caseId: query.case_id,
        limit: query.limit,
        offset: query.offset,
      },
    );

    return {
      data: promises.map(toPromiseToPayResponse),
      total: promises.length,
    };
  }

  public async getPromiseById(
    tenantId: string,
    promiseId: string,
  ): Promise<PromiseToPayResponse> {
    const ptp = await this.repos.findPromiseById(
      { db: this.db },
      { tenantId, promiseId },
    );

    if (!ptp) {
      throw new NotFoundError(`Promise to pay '${promiseId}' not found`);
    }

    return toPromiseToPayResponse(ptp);
  }

  public async markHonored(
    tenantId: string,
    promiseId: string,
    body: MarkPromiseHonoredBody,
    actorId?: string,
  ): Promise<PromiseToPayResponse> {
    const existing = await this.repos.findPromiseById(
      { db: this.db },
      { tenantId, promiseId },
    );

    if (!existing) {
      throw new NotFoundError(`Promise to pay '${promiseId}' not found`);
    }

    if (existing.status !== "MADE") {
      throw new ConflictError(
        `Cannot honor promise '${promiseId}' with terminal status '${existing.status}'`,
      );
    }

    const updated = await this.repos.markPromiseHonored(
      { db: this.db },
      {
        tenantId,
        promiseId,
        paymentId: body.payment_id,
        resolvedAt: new Date(),
      },
    );

    if (!updated) {
      throw new ConflictError(
        `Failed to transition promise '${promiseId}' to HONORED (concurrent modification)`,
      );
    }

    // Append case event and audit log
    await this.repos.recordCaseEvent(
      { db: this.db },
      {
        tenantId,
        caseId: existing.caseId,
        eventType: "PROMISE_HONORED",
        actorType: actorId ? "USER" : "SYSTEM",
        actorId,
        description: `Promise to pay ${promiseId} marked as honored with payment ${body.payment_id}`,
        payload: {
          promiseId,
          paymentId: body.payment_id,
          amount: existing.promisedAmount.toString(),
          currency: existing.currency,
        },
      },
    );

    await this.repos.recordAuditLog(
      { db: this.db },
      {
        tenantId,
        caseId: existing.caseId,
        actorType: actorId ? "USER" : "SYSTEM",
        actorId,
        event: "PROMISE_TO_PAY_HONORED",
        metadata: {
          promiseId,
          paymentId: body.payment_id,
          manualReconciliation: true,
        },
      },
    );

    return toPromiseToPayResponse(updated);
  }
}
