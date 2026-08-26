import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// DIRECT_URL bypasses transaction poolers (PgBouncer/Supavisor) for DDL migrations
const directConnectionString =
  process.env.DIRECT_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/revenue_recovery";

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

  const migrationDb = drizzle(migrationClient);

  try {
    const migrationsFolder = path.resolve(__dirname, "../drizzle");
    await migrate(migrationDb, { migrationsFolder });
    console.log("✅ Migrations applied successfully!");
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  } finally {
    await migrationClient.end();
  }
}

// Allow direct execution via CLI: bun run src/migrate.ts
if ((import.meta as { main?: boolean }).main || process.argv[1]?.endsWith("migrate.ts")) {
  runMigrations();
}
