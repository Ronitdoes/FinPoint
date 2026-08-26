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
 */
export function redactParams(params?: unknown[]): unknown[] {
  if (!params || !Array.isArray(params)) return [];
  return params.map((param) => {
    if (param === null || param === undefined) return param;
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
    console.warn(
      `⚠️ [SLOW QUERY] Duration: ${durationMs}ms | Query: ${query.slice(0, 200)} | Params: ${JSON.stringify(redactParams(params))}`,
    );
  }
}

/**
 * Pooled PostgreSQL client for normal application queries.
 * Manages an active connection pool for high concurrency and low latency.
 */
export const queryClient = postgres(connectionString, {
  prepare: false, // Recommended false when using external transaction poolers like PgBouncer / Supavisor
  debug: (connection, query, params) => {
    // postgres.js debug hook receives (connection, query, params, types)
    if (process.env.NODE_ENV !== "production") {
      const start = Date.now();
      // postgres.js debug fires before query execution; duration logged if hook invoked
    }
  },
});

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
