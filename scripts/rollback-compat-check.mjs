/**
 * Rollback schema-compatibility gate (Step 33 §Requirements 7).
 *
 * Invoked by .github/workflows/rollback.yml BEFORE any redeploy. Verifies:
 *   1. ROLLBACK_TAG is set (previous immutable tag to restore).
 *   2. CONFIRM_SCHEMA_COMPAT=true (explicit human flag acknowledging that
 *      migrations are forward-only — rollback = previous APP on CURRENT
 *      schema; the database is never downgraded).
 *   3. `bun run db:migrate:check` passes against the target environment,
 *      proving the schema is AT LATEST — the precondition the N/N+1
 *      compatibility rule (docs/deploy/migrations.md) depends on.
 *
 * Env: ROLLBACK_TAG (required), CONFIRM_SCHEMA_COMPAT (must be "true"),
 *      DATABASE_URL / DIRECT_URL (+ the usual server env for config parse).
 *
 * Usage: `bun scripts/rollback-compat-check.mjs`
 * Exit code: 0 compatible, 1 blocked.
 */
import { execFileSync } from "node:child_process";

const tag = process.env.ROLLBACK_TAG || "";
const confirmed = process.env.CONFIRM_SCHEMA_COMPAT === "true";

if (!tag) {
  console.error("rollback-compat-check: FAIL — ROLLBACK_TAG is required.");
  process.exit(1);
}

if (!confirmed) {
  console.error(
    "rollback-compat-check: FAIL — CONFIRM_SCHEMA_COMPAT must be 'true'. " +
      "Set the repo/environment variable to acknowledge forward-only rollback " +
      "(previous app on current schema; see docs/deploy/rollback.md).",
  );
  process.exit(1);
}
console.log(
  `rollback-compat-check: flag acknowledged for tag ${tag} (forward-only: app rolls back, schema stays).`,
);

try {
  execFileSync("bun", ["run", "db:migrate:check"], { stdio: "inherit" });
} catch {
  console.error(
    "rollback-compat-check: FAIL — migrate:check is red: schema is NOT at " +
      "latest. Resolve pending/failed migrations before rolling back.",
  );
  process.exit(1);
}

console.log(
  `rollback-compat-check: PASS — schema at latest, tag ${tag} is safe to redeploy on current schema. ` +
    "DB point-in-time recovery remains a last resort requiring owner approval.",
);
