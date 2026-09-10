/**
 * Secret sweep CI gate (Step 30 §Requirements 2).
 *
 * Scans every git-tracked file plus the built frontend bundle and the Docker
 * build contexts for provider-secret-shaped strings and fails the build on
 * any unallowlisted hit.
 *
 * What is scanned:
 *   1. `git ls-files` — everything committed (local-only `.env*` files are
 *      untracked+ignored by design and therefore out of scope here; they are
 *      covered instead by the docker-context check below).
 *   2. `apps/frontend/.next/**` (when present) — the built bundle that ships
 *      to browsers; proves "no provider secret in frontend".
 *   3. Docker context hygiene — every `.dockerignore` in the repo must
 *      exclude `.env*` files so local secrets cannot leak into images.
 *
 * Placeholder values (`...`, `xxx`, `***`, `your-*-here`, `example`,
 * `changeme`, `placeholder`) are ignored so `.env.example` and docs can
 * name the variables without tripping the gate. Exact-value allowlist
 * entries below cover vetted synthetic fixtures; each entry names why the
 * value is safe. Additions require a code-review comment.
 *
 * Usage: `bun scripts/security-sweep.mjs [--bundle-dir <path>]`
 * Exit code: 0 clean, 1 leak found, 2 usage/environment error.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const PATTERNS = [
  { name: "stripe_live_secret", regex: /sk_live_[A-Za-z0-9]{8,}/g },
  { name: "stripe_test_secret", regex: /sk_test_[A-Za-z0-9]{8,}/g },
  { name: "webhook_secret", regex: /whsec_[A-Za-z0-9]{8,}/g },
  { name: "razorpay_key", regex: /rzp_(?:live|test)_[A-Za-z0-9]{4,}/g },
  { name: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "private_key", regex: /BEGIN (?:RSA )?PRIVATE KEY/g },
  { name: "neon_key", regex: /npg_[A-Za-z0-9]{8,}/g },
  { name: "revenue_api_key", regex: /rrk_[A-Za-z0-9_]{12,}/g },
];

const PLACEHOLDER_HINT = /(\.\.\.|xxx|\*\*\*|your-|example|changeme|placeholder|test_override|evil_key|secret|integration|fixture|synthetic|dummy)/i;

// Exact secret-shaped values vetted as synthetic test fixtures (s-30).
// Each entry was manually reviewed: sequential-digit or English-word
// bodies that no provider ever issues. Format: "<relative-path>::<exact
// match>" — keep sorted. Additions require a code-review comment.
const VALUE_ALLOWLIST = new Set([
  // PII-scanner fixture: sequential digits, obviously synthetic.
  "apps/backend/src/tests/audit-timeline-integration.test.ts::sk_live_99998888777766665555",
  "apps/backend/src/tests/audit-timeline-integration.test.ts::sk_test_123456789012345678",
  // Logger redaction fixture: sequential digits.
  "packages/observability/src/logger.test.ts::sk_live_1234567890",
  // Razorpay dev-fallback default + contract fixtures: literal words, never
  // a real credential. Live mode requires env via @repo/config fail-fast.
  "packages/integrations/src/payments/payment-adapters-contract.test.ts::rzp_test_secret",
  "packages/integrations/src/payments/razorpay.adapter.ts::rzp_test_secret",
  // Frozen roadmap prose naming the key pattern (specs/ are append-only).
  "specs/steps/s-30.md::BEGIN PRIVATE KEY",
  // s-30 explainer quotes the same vetted prose (pattern name in English
  // words, not key material). Added s-35 release sweep with rationale.
  "docs/explanation/s-30-explanation.md::BEGIN PRIVATE KEY",
  // load-lite mjs builds a per-run random loopback signing secret
  // (`whsec_loadlite_<8 random hex>`) for local load tests only; the static
  // prefix trips the webhook_secret pattern but no credential is stored.
  // Added s-35 release sweep with rationale.
  "scripts/load-lite.mjs::whsec_loadlite",
]);

// Files whose full content is exempt (they define the gate itself).
const PATH_ALLOWLIST = new Set([
  "scripts/security-sweep.mjs",
  "tests/security/secrets.sweep.test.ts",
]);

function isPlaceholder(match) {
  return PLACEHOLDER_HINT.test(match);
}

function scanText(relativePath, text) {
  const hits = [];
  for (const { name, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
      const value = m[0];
      if (isPlaceholder(value)) continue;
      if (VALUE_ALLOWLIST.has(`${relativePath}::${value}`)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      hits.push({ file: relativePath, line, pattern: name, sample: `${value.slice(0, 12)}...` });
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
  }
  return hits;
}

function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: REPO_ROOT,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out
      .toString("utf8")
      .split("\0")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (err) {
    console.error(`security-sweep: unable to list tracked files (${err.message})`);
    process.exit(2);
  }
}

function isBinaryLike(buffer) {
  // NUL byte heuristic; keeps images/fonts out of the scan.
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

function collectBundleFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      collectBundleFiles(p, out);
    } else if (/\.(js|mjs|cjs|json|html|css|txt)$/.test(name) && st.size <= 5 * 1024 * 1024) {
      out.push(p);
    }
  }
  return out;
}

const args = process.argv.slice(2);
const skipBundle = args.includes("--skip-bundle");
const bundleDirFlag = args.indexOf("--bundle-dir");
const bundleDirs =
  bundleDirFlag >= 0 && args[bundleDirFlag + 1]
    ? [resolve(REPO_ROOT, args[bundleDirFlag + 1])]
    : [
        join(REPO_ROOT, "apps/frontend/.next/standalone"),
        join(REPO_ROOT, "apps/frontend/.next/static"),
      ];

let failures = [];

// 1. Tracked files.
for (const rel of trackedFiles()) {
  if (PATH_ALLOWLIST.has(rel)) continue;
  const abs = join(REPO_ROOT, rel);
  let buffer;
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
    buffer = readFileSync(abs);
  } catch {
    continue;
  }
  if (isBinaryLike(buffer)) continue;
  failures.push(...scanText(rel, buffer.toString("utf8")));
}

// 2. Built frontend bundle (when present — CI builds before this gate).
let bundleScanned = 0;
if (!skipBundle) {
  for (const dir of bundleDirs) {
    if (!existsSync(dir)) continue;
    for (const abs of collectBundleFiles(dir)) {
      const rel = abs.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
      let buffer;
      try {
        buffer = readFileSync(abs);
      } catch {
        continue;
      }
      if (isBinaryLike(buffer)) continue;
      bundleScanned++;
      failures.push(...scanText(rel, buffer.toString("utf8")));
    }
  }
}

// 3. Docker context hygiene: every .dockerignore must exclude .env* and .git.
const dockerignoreChecks = [
  { file: ".dockerignore", required: [/^\.env\*/m, /(\.git)/] },
  { file: "infra/docker/.dockerignore", required: [/^\.env\*/m, /(\.git)/] },
];
for (const { file, required } of dockerignoreChecks) {
  const abs = join(REPO_ROOT, file);
  if (!existsSync(abs)) {
    failures.push({
      file,
      line: 0,
      pattern: "dockerignore_missing",
      sample: `${file} does not exist`,
    });
    continue;
  }
  const content = readFileSync(abs, "utf8");
  for (const pattern of required) {
    if (!pattern.test(content)) {
      failures.push({
        file,
        line: 0,
        pattern: "dockerignore_gap",
        sample: `${file} must exclude ${pattern}`,
      });
    }
  }
}

if (failures.length > 0) {
  console.error(`security-sweep: ${failures.length} unallowlisted secret hit(s):`);
  for (const hit of failures.slice(0, 50)) {
    console.error(`  ${hit.file}:${hit.line} [${hit.pattern}] ${hit.sample}`);
  }
  if (failures.length > 50) {
    console.error(`  ... and ${failures.length - 50} more`);
  }
  process.exit(1);
}

console.log(
  `security-sweep: clean (bundle files scanned: ${bundleScanned}).`,
);
