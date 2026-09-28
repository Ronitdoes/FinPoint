import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const connectionString =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/revenue_recovery";

export type QueryLogHook = (query: string, durationMs: number, params?: unknown[]) => void;

/**
 * Redacts sensitive/long parameters from query logs (secrets, PII, long payload blobs).
 * BigInts (money in minor units) are stringified — JSON.stringify throws on raw BigInt.
 */
export function redactParams(params?: unknown[]): unknown[] {
  if (!params || !Array.isArray(params)) return [];
  return params.map((param) => {
    if (param === null || param === undefined) return param;
    if (typeof param === "bigint") return `${param.toString()}n`;
    if (typeof param === "string") {
      if (param.startsWith("sk_") || param.startsWith("whsec_") || param.length > 50) {
        return `${param.slice(0, 4)}...[REDACTED]`;
      }
      return param;
    }
    if (typeof param === "object") {
      return "[OBJECT/PAYLOAD]";
    }
    return param;
  });
}

let customQueryHook: QueryLogHook | null = null;

export function setOnQueryHook(hook: QueryLogHook | null): void {
  customQueryHook = hook;
}

export function logSlowQuery(query: string, durationMs: number, params?: unknown[]): void {
  if (customQueryHook) {
    customQueryHook(query, durationMs, params);
    return;
  }

  // Default dev hook: warn when query takes > 200ms
  if (durationMs > 200) {
    let paramsJson = "[UNPRINTABLE PARAMS]";
    try {
      paramsJson = JSON.stringify(redactParams(params));
    } catch {
      // Redaction must never break query execution or tests.
    }
    console.warn(
      `⚠️ [SLOW QUERY] Duration: ${durationMs}ms | Query: ${query.slice(0, 200)} | Params: ${paramsJson}`,
    );
  }
}

/**
 * Pooled PostgreSQL client for normal application queries.
 * Manages an active connection pool for high concurrency and low latency.
 */
export const queryClient = postgres(connectionString, {
  prepare: false, // Recommended false when using external transaction poolers like PgBouncer / Supavisor
  debug: () => {
    // Intentionally minimal: postgres.js invokes `debug` synchronously BEFORE
    // dispatch with no completion signal, so it cannot measure duration.
    // Per-query durations are measured in the `unsafe` wrapper below instead.
    // Prod safety: this hook never logs; slow-query output via logSlowQuery is
    // redacted and (by default) only emitted past the 200ms threshold.
  },
});

/**
 * Slow-query timing wrapper (s-06 observability: >200ms logged, params redacted).
 *
 * All Drizzle repository traffic flows through `queryClient.unsafe(query, params)`.
 * The wrapper forwards the call untouched and reports settle latency to
 * {@link logSlowQuery} (custom hook when set via {@link setOnQueryHook},
 * otherwise a dev/prod-safe >200ms console warning with redacted params).
 *
 * Non-breaking by construction: the original Query thenable is returned as-is,
 * so `.values()` / `.execute()` / `.cancel()` chaining keeps working (an `async`
 * wrapper would strip those and break Drizzle reads + transactions). Direct
 * template-tag calls (e.g. `healthCheck`) bypass `unsafe` and are not timed —
 * negligible single-statement traffic.
 */
const rawUnsafe = queryClient.unsafe.bind(queryClient);
queryClient.unsafe = ((...args: Parameters<typeof rawUnsafe>) => {
  const start = Date.now();
  const pending = rawUnsafe(...args);
  const report = () => {
    try {
      logSlowQuery(String(args[0]), Date.now() - start, args[1] as unknown[]);
    } catch {
      // Observability must never break query execution (incl. throwing custom hooks).
    }
  };
  // Adopt (don't replace) the thenable: handlers observe settle latency while
  // Drizzle awaits the original Query object with its interface intact.
  void Promise.resolve(pending).then(report, report);
  return pending;
}) as typeof queryClient.unsafe;

export const db = drizzle(queryClient, { schema });

export type Database = typeof db;

/**
 * Verifies database connectivity and responsiveness.
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const result = await queryClient`SELECT 1 as healthy`;
    return result.length > 0 && result[0].healthy === 1;
  } catch (error) {
    return false;
  }
}

/**
 * Gracefully closes all pool connections.
 */
export async function end(): Promise<void> {
  await queryClient.end();
}
