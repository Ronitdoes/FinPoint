import type { Database } from "../client";
import { db } from "../client";

/**
 * Transaction type wrapping the full PostgreSQL Drizzle schema.
 */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Context object passed to repository methods containing either a database pool client or an active transaction.
 */
export interface RepoContext {
  db?: Database;
  tx?: Tx;
}

/**
 * Resolves the active query executor from the repository context, defaulting to the global db pool.
 */
export function getExecutor(ctx?: RepoContext): Database | Tx {
  return ctx?.tx ?? ctx?.db ?? db;
}
