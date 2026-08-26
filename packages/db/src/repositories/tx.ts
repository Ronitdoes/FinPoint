import { db } from "../client";
import type { RepoContext, Tx } from "./types";

export type { Tx };

/**
 * Executes a function within an explicit database transaction boundary.
 * If already inside an active transaction in `ctx`, reuses the transaction.
 *
 * @example
 * ```ts
 * const result = await withTransaction(async (tx) => {
 *   const caseRow = await createCaseInTx(tx, { tenantId, ... });
 *   await recordCaseEvent({ tx }, { tenantId, caseId: caseRow.id, ... });
 *   return caseRow;
 * });
 * ```
 */
export async function withTransaction<T>(
  fnOrCtx: RepoContext | ((tx: Tx) => Promise<T>),
  maybeFn?: (tx: Tx) => Promise<T>,
): Promise<T> {
  let ctx: RepoContext | undefined;
  let fn: (tx: Tx) => Promise<T>;

  if (typeof fnOrCtx === "function") {
    fn = fnOrCtx;
  } else {
    ctx = fnOrCtx;
    fn = maybeFn!;
  }

  // If already inside an active transaction context, reuse it directly
  if (ctx?.tx) {
    return await fn(ctx.tx);
  }

  const executor = ctx?.db ?? db;
  return await executor.transaction(async (tx) => {
    return await fn(tx);
  });
}
