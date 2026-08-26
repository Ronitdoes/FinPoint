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

/**
 * Pooled PostgreSQL client for normal application queries.
 * Manages an active connection pool for high concurrency and low latency.
 */
export const queryClient = postgres(connectionString, {
  prepare: false, // Recommended false when using external transaction poolers like PgBouncer / Supavisor
});

export const db = drizzle(queryClient, { schema });

export type Database = typeof db;
