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
const directConnectionString =
  process.env.DIRECT_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/revenue_recovery";

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

  /**
   * Direct, single-connection PostgreSQL client for migrations.
   * Ensures advisory locks and DDL statements execute without pooler interference.
   */
  const migrationClient = postgres(directConnectionString, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: 15,
  });

  try {
    console.log(`🔒 Acquiring migration advisory lock (${MIGRATION_ADVISORY_LOCK_ID})...`);
    await migrationClient`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_ID})`;

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

        console.error("❌ Migration failed:", error);
        throw error;
      }
    }
  } finally {
    try {
      await migrationClient`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_ID})`;
      console.log(`🔓 Released migration advisory lock (${MIGRATION_ADVISORY_LOCK_ID})`);
    } catch (unlockError) {
      console.error("⚠️ Failed to release advisory lock:", unlockError);
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
    console.error("❌ Migration check failed with error:", err);
    process.exit(1);
  }
}

// Allow direct execution via CLI
if ((import.meta as { main?: boolean }).main || process.argv[1]?.endsWith("migrate.ts")) {
  if (process.argv.includes("--check")) {
    runMigrationCheck();
  } else {
    runMigrations().catch(() => process.exit(1));
  }
}
