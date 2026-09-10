/**
 * Image + deploy hygiene gate (Step 33 §Requirements 1, §Tests).
 *
 * Verifies, without needing docker or credentials:
 *  1. All four Dockerfiles exist, install `--frozen-lockfile`, and pin every
 *     FROM by digest (extends the s-30 dependency-audit policy).
 *  2. The apps/* Dockerfile twins are in sync with the canonical
 *     infra/docker/* images (compared ignoring comment/blank lines).
 *  3. Frontend images declare ONLY NEXT_PUBLIC_* build ARGs (any other ARG
 *     would bake a secret into the client bundle layers — CONVENTIONS §12).
 *  4. The unified backend entrypoint exists, and compose worker services
 *     disable the HTTP HEALTHCHECK (workers expose no port).
 *  5. All three workflows + the smoke/compat scripts exist.
 *
 * Usage: `bun scripts/deploy-check.mjs`
 * Exit code: 0 pass, 1 gate failure.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

let failures = 0;

function fail(message) {
  console.error(`deploy-check: FAIL — ${message}`);
  failures += 1;
}

function pass(message) {
  console.log(`deploy-check: ok — ${message}`);
}

function read(rel) {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    fail(`${rel} is missing.`);
    return null;
  }
  return readFileSync(abs, "utf8");
}

const BACKEND_CANON = "infra/docker/backend.Dockerfile";
const BACKEND_TWIN = "apps/backend/Dockerfile";
const FRONTEND_CANON = "infra/docker/frontend.Dockerfile";
const FRONTEND_TWIN = "apps/frontend/Dockerfile";

// 1. Frozen lockfile + digest pins on every image.
for (const rel of [BACKEND_CANON, BACKEND_TWIN, FRONTEND_CANON, FRONTEND_TWIN]) {
  const content = read(rel);
  if (content === null) continue;
  if (!/--frozen-lockfile/.test(content)) {
    fail(`${rel} must install with --frozen-lockfile.`);
  }
  const fromLines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("FROM "));
  if (fromLines.length === 0) {
    fail(`${rel} declares no FROM stage.`);
  }
  const unpinned = fromLines.filter((l) => !/@sha256:[0-9a-f]{64}/.test(l));
  if (unpinned.length > 0) {
    fail(`${rel} has base image(s) without digest pin: ${unpinned.join("; ")}.`);
  }
}
pass("Dockerfiles install frozen and pin every base image by digest.");

// 2. Twin sync (ignoring comment + blank lines so headers may differ).
function bodyLines(content) {
  return content
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
}
for (const [canon, twin] of [
  [BACKEND_CANON, BACKEND_TWIN],
  [FRONTEND_CANON, FRONTEND_TWIN],
]) {
  const a = read(canon);
  const b = read(twin);
  if (a === null || b === null) continue;
  const la = bodyLines(a).join("\n");
  const lb = bodyLines(b).join("\n");
  if (la !== lb) {
    fail(`${twin} drifted from canonical ${canon} (stage bodies differ).`);
  } else {
    pass(`${twin} is in sync with ${canon}.`);
  }
}

// 3. Frontend ARG allowlist: NEXT_PUBLIC_* only.
for (const rel of [FRONTEND_CANON, FRONTEND_TWIN]) {
  const content = read(rel);
  if (content === null) continue;
  const args = [...content.matchAll(/^\s*ARG\s+([A-Za-z0-9_]+)/gm)].map(
    (m) => m[1],
  );
  const forbidden = args.filter((a) => !a.startsWith("NEXT_PUBLIC_"));
  if (forbidden.length > 0) {
    fail(
      `${rel} declares non-public build ARG(s) ${forbidden.join(", ")} — only NEXT_PUBLIC_* may be baked into the client bundle.`,
    );
  }
}
pass("Frontend images carry only NEXT_PUBLIC_* build args.");

// 4. Entrypoint + worker healthcheck policy.
const entry = read("infra/docker/backend-entrypoint.sh");
if (entry !== null) {
  for (const mode of ['"api"', '"worker"', '"migrate"', '"migrate:check"']) {
    // modes appear as case branches: `api)`, `worker)`, ...
    const branch = mode.replaceAll('"', "") + ")";
    if (!entry.includes(branch)) {
      fail(`backend-entrypoint.sh is missing the '${branch}' mode branch.`);
    }
  }
  if (!/FATAL: missing required config/.test(entry)) {
    fail("backend-entrypoint.sh must fail LOUDLY listing missing keys.");
  } else {
    pass("Unified entrypoint covers api/worker/migrate/migrate:check with loud fail-fast.");
  }
}
for (const rel of [
  "infra/docker/docker-compose.yml",
  "tests/e2e/setup/compose.e2e.yml",
]) {
  const content = read(rel);
  if (content === null) continue;
  // Every `command: ["worker"]` service must neutralize the image
  // HEALTHCHECK (GET /health) since workers expose no HTTP port.
  // (Full-line comments are stripped first — headers mention the pattern.)
  const code = content
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  const workerBlocks = code.split(/(?=^\s{2}\w[\w-]*:\s*$)/m);
  for (const block of workerBlocks) {
    if (/command:\s*\["worker"\]/.test(block) && !/test:\s*\["NONE"\]/.test(block)) {
      fail(`${rel}: a worker-mode service does not disable the HTTP healthcheck.`);
    }
  }
}
pass("Worker services disable the image HTTP healthcheck.");

// 5. Workflows + scripts present.
for (const rel of [
  ".github/workflows/ci.yml",
  ".github/workflows/deploy-staging.yml",
  ".github/workflows/rollback.yml",
  "scripts/smoke-staging.mjs",
  "scripts/rollback-compat-check.mjs",
  "docs/deploy/environments.md",
  "docs/deploy/migrations.md",
  "docs/deploy/webhooks.md",
  "docs/deploy/crons.md",
  "docs/deploy/rollback.md",
]) {
  if (!existsSync(join(REPO_ROOT, rel))) {
    fail(`${rel} is missing.`);
  }
}
pass("Workflows, scripts, and deploy docs are all present.");

if (failures > 0) {
  console.error(`deploy-check: ${failures} failure(s).`);
  process.exit(1);
}
console.log("deploy-check: PASS — deployment hygiene green.");
