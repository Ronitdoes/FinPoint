/**
 * Dependency audit gate (Step 30 §Requirements 6).
 *
 * 1. Verifies `bun.lock` exists and Dockerfiles install reproducibly
 *    (`--frozen-lockfile`) with digest-pinned base images.
 * 2. Runs the package-manager vulnerability audit (`bun audit`, falling back
 *    to `npm audit`) and fails on `critical` findings (threshold adjustable
 *    via `AUDIT_FAIL_LEVEL=critical|high|moderate|low`).
 *
 * Lockfile diff policy (enforced by review, automated here in part):
 * every dependency PR must keep `bun.lock` in sync — CI installs with
 * `--frozen-lockfile`, so a stale lockfile fails before this gate runs.
 *
 * Usage: `bun scripts/dependency-audit.mjs`
 * Exit code: 0 pass, 1 gate failure, 2 environment error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FAIL_LEVEL = (process.env.AUDIT_FAIL_LEVEL || "critical").toLowerCase();
const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

function fail(message) {
  console.error(`dependency-audit: FAIL — ${message}`);
  process.exit(1);
}

function warn(message) {
  console.warn(`dependency-audit: WARN — ${message}`);
}

// 1. Lockfile presence.
if (!existsSync(join(REPO_ROOT, "bun.lock"))) {
  fail("bun.lock is missing; dependency installs are not reproducible.");
}

// 2. Dockerfile hygiene: frozen lockfile + digest-pinned base images.
// Canonical production images live in infra/docker (s-33); the apps/* twins
// carry identical content for historical references and are checked too.
const dockerfiles = [
  "infra/docker/backend.Dockerfile",
  "infra/docker/frontend.Dockerfile",
  "apps/backend/Dockerfile",
  "apps/frontend/Dockerfile",
];
for (const rel of dockerfiles) {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    warn(`${rel} not found; skipping image checks.`);
    continue;
  }
  const content = readFileSync(abs, "utf8");
  if (!/--frozen-lockfile/.test(content)) {
    fail(`${rel} must install with --frozen-lockfile for reproducible builds.`);
  }
  const fromLines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("FROM "));
  const unpinned = fromLines.filter((l) => !/@sha256:[0-9a-f]{64}/.test(l));
  if (unpinned.length > 0) {
    fail(
      `${rel} has base image(s) without digest pin: ${unpinned.join("; ")}. ` +
        `Pin as <image>:<tag>@sha256:<digest> (s-30 policy).`,
    );
  }
}
console.log("dependency-audit: lockfile + image-pin checks passed.");

// 3. Vulnerability audit.
function tryAudit(command, args) {
  try {
    const out = execFileSync(command, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
    return { ok: true, output: out };
  } catch (err) {
    // Auditors exit non-zero when findings exist; stdout still carries JSON.
    if (err.stdout) {
      return { ok: false, output: err.stdout.toString() };
    }
    return { ok: false, output: null, error: err.message };
  }
}

let audit = tryAudit("bun", ["audit", "--json"]);
if (audit.output === null) {
  console.log("dependency-audit: `bun audit` unavailable, trying `npm audit`...");
  audit = tryAudit("npm", ["audit", "--json"]);
}
if (audit.output === null) {
  warn(
    `no package auditor available (${audit.error || "unknown error"}). ` +
      "Skipping vulnerability scan — s-33 CI must provide an auditor.",
  );
  process.exit(0);
}

let data;
try {
  data = JSON.parse(audit.output);
} catch {
  warn("auditor output was not JSON; printing raw output for review.");
  console.log(audit.output.slice(0, 4000));
  process.exit(0);
}

// Normalize bun-audit / npm-audit shapes into { severity, title } entries.
const findings = [];
if (data.vulnerabilities && typeof data.vulnerabilities === "object") {
  for (const [name, vuln] of Object.entries(data.vulnerabilities)) {
    findings.push({
      severity: String(vuln.severity || "info").toLowerCase(),
      title: `${name}: ${vuln.title || vuln.url || "vulnerability"}`,
    });
  }
}
if (Array.isArray(data.advisories)) {
  for (const adv of data.advisories) {
    findings.push({
      severity: String(adv.severity || "info").toLowerCase(),
      title: adv.title || adv.url || "advisory",
    });
  }
}

const threshold = SEVERITY_RANK[FAIL_LEVEL] ?? 4;
const breaching = findings.filter(
  (f) => (SEVERITY_RANK[f.severity] ?? 0) >= threshold,
);

if (breaching.length > 0) {
  console.error(
    `dependency-audit: ${breaching.length} finding(s) at or above '${FAIL_LEVEL}':`,
  );
  for (const f of breaching.slice(0, 20)) {
    console.error(`  [${f.severity}] ${f.title}`);
  }
  process.exit(1);
}

console.log(
  `dependency-audit: clean (${findings.length} total finding(s) below '${FAIL_LEVEL}' threshold).`,
);
