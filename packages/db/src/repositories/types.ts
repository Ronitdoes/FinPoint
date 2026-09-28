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
 * Allowlisted cross-tenant (optional-tenant) sweeper/admin reads.
 *
 * Every other business-repo method takes a mandatory `tenantId` first parameter.
 * Exactly these 5 readers accept an OPTIONAL tenant so background sweepers and
 * webhook correlators can operate without tenant context; each is tagged
 * `@allowCrossTenant` at its definition and MUST scope every follow-up write by
 * the row's own tenantId:
 *
 * 1. events.repo `listUnprocessedEvents` — unprocessed-event sweeper polling.
 * 2. events.repo `findEventsByFilter` — admin/support event search.
 * 3. actions.repo `findStuckExecutingActions` — EXECUTING-stuck claim sweeper.
 * 4. messages.repo `findMessageByProviderMessageId` — webhook correlation by
 *    provider message id (arrives without tenant context).
 * 5. outcomes.repo `findCandidateCasesForAttributionSweep` — attribution sweeper.
 */

/**
 * Resolves the active query executor from the repository context, defaulting to the global db pool.
 */
export function getExecutor(ctx?: RepoContext): Database | Tx {
  return ctx?.tx ?? ctx?.db ?? db;
}
