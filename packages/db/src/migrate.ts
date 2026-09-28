import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// DIRECT_URL bypasses transaction poolers (PgBouncer/Supavisor) for DDL migrations
const FALLBACK_CONNECTION_STRING = "postgres://postgres:postgres@localhost:5432/revenue_recovery";

const connectionSource: "DIRECT_URL" | "DATABASE_URL" | "fallback-localhost" =
  process.env.DIRECT_URL ? "DIRECT_URL" : process.env.DATABASE_URL ? "DATABASE_URL" : "fallback-localhost";

const directConnectionString = process.env.DIRECT_URL || process.env.DATABASE_URL || FALLBACK_CONNECTION_STRING;

/**
 * Fails fast when CI would silently fall back to localhost because the
 * staging/prod secrets are unset. Without this, a missing STAGING_DIRECT_URL
 * surfaces as a cryptic ECONNREFUSED 127.0.0.1:5432 instead of the real cause.
 * Local dev (no CI=true) keeps the localhost fallback.
 */
function assertConnectionConfigured(caller: string): void {
  if (connectionSource === "fallback-localhost" && process.env.CI === "true") {
    throw new Error(
      `${caller}: neither DIRECT_URL nor DATABASE_URL is set (CI=true). ` +
        `In deploy-staging this means the 'staging' environment secrets ` +
        `STAGING_DIRECT_URL / STAGING_DATABASE_URL are missing or the environment ` +
        `protection rule did not expose them to this job. ` +
        `Set the secrets per docs/deploy/environments.md; refusing to migrate localhost.`,
    );
  }
}

/**
 * Rewrites low-level connection failures into actionable errors.
 * Never includes the connection string (may carry credentials).
 */
function toActionableConnectionError(err: unknown, caller: string): Error {
  const code = (err as { code?: string })?.code;
  if (code === "ECONNREFUSED") {
    const hint =
      process.env.CI === "true"
        ? "Check that the target database host is reachable from this runner and that " +
          "STAGING_DIRECT_URL points at it (not localhost). Locally, run 'bun run infra:up' first."
        : "Is Postgres running? Start it with 'bun run infra:up' " +
          "(expects postgres://postgres:postgres@localhost:5432/revenue_recovery), " +
          "or set DIRECT_URL/DATABASE_URL.";
    return new Error(`${caller}: connect ECONNREFUSED via ${connectionSource}. ${hint}`);
  }
  return err instanceof Error ? err : new Error(`${caller}: ${String(err)}`);
}

const MIGRATION_ADVISORY_LOCK_ID = 724193;

export interface MigrationCheckResult {
  hasPending: boolean;
  pendingCount: number;
  appliedCount: number;
  totalCount: number;
}

/**
 * Checks if there are pending DDL migrations without applying them.
 * Useful for CI gates and container startup healthchecks.
 */
export async function checkPendingMigrations(): Promise<MigrationCheckResult> {
  assertConnectionConfigured("db:migrate:check");
  const client = postgres(directConnectionString, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 15,
  });

  try {
    const journalPath = path.resolve(__dirname, "../drizzle/meta/_journal.json");
    if (!fs.existsSync(journalPath)) {
      return { hasPending: false, pendingCount: 0, appliedCount: 0, totalCount: 0 };
    }

    const journalRaw = fs.readFileSync(journalPath, "utf-8");
    const journal = JSON.parse(journalRaw);
    const totalCount = Array.isArray(journal.entries) ? journal.entries.length : 0;

    // Check if Drizzle migrations table exists
    const tableExists = await client`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
      ) as exists
    `;

    let appliedCount = 0;
    if (tableExists[0]?.exists) {
      const rows = await client`SELECT COUNT(*)::int as count FROM drizzle.__drizzle_migrations`;
      appliedCount = rows[0]?.count ?? 0;
    }

    const pendingCount = Math.max(0, totalCount - appliedCount);
    const hasPending = pendingCount > 0;

    return { hasPending, pendingCount, appliedCount, totalCount };
  } finally {
    await client.end();
  }
}

/**
 * Applies pending migrations wrapped in a PostgreSQL advisory lock (724193)
 * and retries once on transient serialization or deadlock failures.
 */
export async function runMigrations() {
  console.log("⏳ Running database migrations with direct connection...");
  assertConnectionConfigured("db:migrate");

  /**
   * Direct, single-connection PostgreSQL client for migrations.
   * Ensures advisory locks and DDL statements execute without pooler interference.
   */
  const migrationClient = postgres(directConnectionString, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 15,
  });

  let lockAcquired = false;
  try {
    console.log(`🔒 Acquiring migration advisory lock (${MIGRATION_ADVISORY_LOCK_ID})...`);
    try {
      await migrationClient`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;
    } catch (err) {
      throw toActionableConnectionError(err, "db:migrate");
    }
    lockAcquired = true;

    const migrationDb = drizzle(migrationClient);
    const migrationsFolder = path.resolve(__dirname, "../drizzle");

    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        console.log(`⏳ Applying migrations (attempt ${attempts}/${maxAttempts})...`);
        await migrate(migrationDb, { migrationsFolder });
        console.log("✅ Migrations applied successfully!");
        break;
      } catch (error: any) {
        const isTransient =
          error?.code === "40001" ||
          error?.code === "40P01" ||
          /could not serialize/i.test(error?.message || "") ||
          /deadlock detected/i.test(error?.message || "");

        if (attempts < maxAttempts && isTransient) {
          console.warn("⚠️ Migration encountered transient serialization failure; retrying once in 500ms...");
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }

        console.error("❌ Migration failed:", toActionableConnectionError(error, "db:migrate"));
        throw toActionableConnectionError(error, "db:migrate");
      }
    }
  } finally {
    // Only unlock when we actually hold the lock: if the initial connect or
    // lock acquisition failed, an unlock attempt just replays the same
    // connection error and buries the real cause (seen as "Failed to release
    // advisory lock" + ECONNREFUSED noise in deploy-staging logs).
    if (lockAcquired) {
      try {
        await migrationClient`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
        console.log(`🔓 Released migration advisory lock (${MIGRATION_ADVISORY_LOCK_ID})`);
      } catch (unlockError) {
        console.error("⚠️ Failed to release advisory lock:", unlockError);
      }
    }
    await migrationClient.end();
  }
}

/**
 * CI check entry point: exits 0 if migrations are up-to-date, exits 1 if pending migrations exist.
 */
export async function runMigrationCheck() {
  console.log("🔍 Checking for pending migrations...");
  try {
    const { hasPending, pendingCount, appliedCount, totalCount } = await checkPendingMigrations();
    if (hasPending) {
      console.error(
        `❌ Pending migrations detected: ${pendingCount} migration(s) unapplied (${appliedCount}/${totalCount} applied). Run 'bun run db:migrate' to apply.`,
      );
      process.exit(1);
    } else {
      console.log(`✅ All ${totalCount} migration(s) are applied. Database schema is up to date.`);
    }
  } catch (err) {
    console.error("❌ Migration check failed with error:", toActionableConnectionError(err, "db:migrate:check"));
    process.exit(1);
  }
}

// Allow direct execution via CLI
if ((import.meta as { main?: boolean }).main || process.argv[1]?.endsWith("migrate.ts")) {
  if (process.argv.includes("--check")) {
    runMigrationCheck();
  } else {
    runMigrations().catch((err: unknown) => {
      // Pre-connection failures (e.g. missing secrets in CI) throw before the
      // runner's own logging; surface them instead of exiting silently.
      console.error("❌ Migration failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
  }
}
