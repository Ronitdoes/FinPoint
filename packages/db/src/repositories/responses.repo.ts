import { and, desc, eq } from "drizzle-orm";
import {
  customerResponses,
  type CustomerResponse,
  type NewCustomerResponse,
} from "../schema/messages";
import { type RepoContext, getExecutor } from "./types";

export interface CreateCustomerResponseInput {
  tenantId: string;
  customerId: string;
  caseId?: string;
  channel?: NewCustomerResponse["channel"];
  type: NewCustomerResponse["type"];
  contentRedacted?: string;
  rawRef?: string;
  receivedAt?: Date;
}

export async function createCustomerResponse(
  ctx: RepoContext,
  input: CreateCustomerResponseInput,
): Promise<CustomerResponse> {
  const executor = getExecutor(ctx);
  const [created] = await executor
    .insert(customerResponses)
    .values({
      tenantId: input.tenantId,
      customerId: input.customerId,
      caseId: input.caseId,
      channel: input.channel,
      type: input.type,
      contentRedacted: input.contentRedacted,
      rawRef: input.rawRef,
      receivedAt: input.receivedAt ?? new Date(),
    })
    .returning();
  return created;
}

export async function findCustomerResponseById(
  ctx: RepoContext,
  { tenantId, responseId }: { tenantId: string; responseId: string },
): Promise<CustomerResponse | null> {
  const executor = getExecutor(ctx);
  const [response] = await executor
    .select()
    .from(customerResponses)
    .where(
      and(
        eq(customerResponses.tenantId, tenantId),
        eq(customerResponses.id, responseId),
      ),
    )
    .limit(1);
  return response ?? null;
}

export async function listResponsesForCustomer(
  ctx: RepoContext,
  {
    tenantId,
    customerId,
    limit = 50,
    offset = 0,
  }: { tenantId: string; customerId: string; limit?: number; offset?: number },
): Promise<CustomerResponse[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(customerResponses)
    .where(
      and(
        eq(customerResponses.tenantId, tenantId),
        eq(customerResponses.customerId, customerId),
      ),
    )
    .orderBy(desc(customerResponses.receivedAt))
    .limit(limit)
    .offset(offset);
}

export async function listResponsesForCase(
  ctx: RepoContext,
  { tenantId, caseId }: { tenantId: string; caseId: string },
): Promise<CustomerResponse[]> {
  const executor = getExecutor(ctx);
  return await executor
    .select()
    .from(customerResponses)
    .where(
      and(
        eq(customerResponses.tenantId, tenantId),
        eq(customerResponses.caseId, caseId),
      ),
    )
    .orderBy(desc(customerResponses.receivedAt));
}
