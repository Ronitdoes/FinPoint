import { z } from "zod";
import { PROMISE_TO_PAY_STATUSES } from "@repo/domain";

export const listPromisesToPayQuerySchema = z.object({
  status: z.enum(PROMISE_TO_PAY_STATUSES as unknown as [string, ...string[]]).optional(),
  customer_id: z.string().uuid().optional(),
  case_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListPromisesToPayQuery = z.infer<typeof listPromisesToPayQuerySchema>;

export const promiseToPayParamsSchema = z.object({
  id: z.string().uuid(),
});

export type PromiseToPayParams = z.infer<typeof promiseToPayParamsSchema>;

export const markPromiseHonoredBodySchema = z.object({
  payment_id: z.string().uuid("payment_id must be a valid UUID"),
});

export type MarkPromiseHonoredBody = z.infer<typeof markPromiseHonoredBodySchema>;
