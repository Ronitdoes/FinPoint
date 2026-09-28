/**
 * Boundary lint audit (Step 35 §Requirements 2).
 *
 * Static architectural-boundary gate per CONVENTIONS.md:
 *   1. No AI → adapter paths: `apps/backend/src/modules/ai/**` must not
 *      import provider adapters (`@repo/integrations`, `packages/integrations`,
 *      `stripe`, `razorpay`, Temporal workflow client dispatch).
 *   2. No provider credentials outside `packages/config` (typed loader) and
 *      `packages/integrations` (adapters). Webhook *verification* secrets at
 *      the gateway (`apps/backend/src/modules/webhooks`, messaging webhook
 *      routes) and the demo loopback signer are vetted design, not leaks —
 *      they are reported as INFO, not failures.
 *   3. No raw SQL outside `packages/db` repositories/seeds/migrations.
 *   4. Zero bare TODO/FIXME/HACK without a linked pointer (`TODO(#12)`,
 *      `TODO s-36`, `HACK: <reason> + owner`). Bare markers fail the gate.
 *   5. Temporal workflow determinism advisory: Date.now()/Math.random() in
 *      non-test `services/worker/src/workflows/**` is reported as WARN with
 *      a pointer (replay-safety review), not a failure.
 *   6. `process.env` outside `packages/config` is reported as WARN
 *      (grandfathered bootstrap/test/edge reads; CONVENTIONS §1 aspiration
 *      tracked, not yet zero).
 *
 * Scans the working tree (git-tracked TS/TSX/MJS sources; skips
 * node_modules, dist, .next, coverage). Test files (`*.test.ts`) are
 * excluded from rules 1–3 (fixtures intentionally cross boundaries).
 *
 * Usage: `bun scripts/audit-boundaries.ts`
 * Exit code: 0 pass (WARN/INFO allowed), 1 boundary failure.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");

interface Finding {
  severity: "ERROR" | "WARN" | "INFO";
  rule: string;
  file: string;
  line: number;
  detail: string;
}

const findings: Finding[] = [];

function add(
  severity: Finding["severity"],
  rule: string,
  file: string,
  line: number,
  detail: string,
) {
  findings.push({ severity, rule, file, line, detail });
}

// ---------------------------------------------------------------------------
// File collection (git-tracked sources only — what ships).
// ---------------------------------------------------------------------------
function trackedSources(): string[] {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return out
    .toString("utf8")
    .split("\0")
    .map((s) => s.trim())
    .filter(
      (s) =>
        /\.(ts|tsx|mjs)$/.test(s) &&
        !s.includes("node_modules") &&
        !s.includes("/dist/") &&
        !s.includes(".next") &&
        !s.includes("/coverage/"),
    );
}

function readLines(rel: string): string[] | null {
  try {
    const st = statSync(join(REPO_ROOT, rel));
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    return readFileSync(join(REPO_ROOT, rel), "utf8").split("\n");
  } catch {
    return null;
  }
}

const isTest = (f: string) => /\.test\.tsx?$/.test(f);

// ---------------------------------------------------------------------------
// Rule 1 — AI must not reach adapters or execution.
// ---------------------------------------------------------------------------
const AI_ADAPTER_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "integrations-import", re: /from\s+["']@repo\/integrations[^"']*["']/ },
  { name: "integrations-relpath", re: /packages\/integrations\// },
  { name: "provider-sdk", re: /require\(["']stripe["']\)|from\s+["']stripe["']|razorpay["']\)/ },
  { name: "temporal-dispatch", re: /workflow\.start\(|signalWithStart\(|getHandle\(/ },
  { name: "direct-send", re: /\.(sendMessage|chargePayment|executePayment|retryPayment)\s*\(/ },
];

function ruleAiBoundaries(file: string, lines: string[]) {
  if (!file.startsWith("apps/backend/src/modules/ai/") || isTest(file)) return;
  lines.forEach((text, i) => {
    for (const { name, re } of AI_ADAPTER_PATTERNS) {
      if (re.test(text)) {
        add("ERROR", "ai-boundary", file, i + 1, `AI module reaches execution layer (${name}): ${text.trim().slice(0, 120)}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Rule 2 — provider credentials confined to config + integrations.
// ---------------------------------------------------------------------------
const CRED_RE =
  /STRIPE_SECRET_KEY|RAZORPAY_KEY_SECRET|RAZORPAY_KEY_ID|WHATSAPP_API_KEY|WHATSAPP_PHONE_NUMBER_ID|EMAIL_API_KEY|EMAIL_FROM/;
const CRED_ALLOWED_PREFIXES = ["packages/config/", "packages/integrations/"];
// Webhook *verification* secrets are consumed at the gateway by design
// (CONVENTIONS §12: verification precedes any processing). Vetted paths.
const WEBHOOK_SECRET_FILES = new Set([
  "apps/backend/src/modules/webhooks/routes.ts",
  "apps/backend/src/modules/messaging/webhooks/whatsapp.routes.ts",
  "apps/backend/src/modules/messaging/webhooks/email.routes.ts",
  "apps/backend/src/modules/demo/simulator.service.ts", // loopback signer, demo-only
  "apps/backend/src/modules/demo/injections.ts", // env-flag reads, no secret values
]);

function ruleCreds(file: string, lines: string[]) {
  if (isTest(file)) return;
  // Self-scan guard: this file necessarily names the credential literals
  // inside its own CRED_RE / webhook-secret patterns. Scanning it would
  // always self-flag (s-35 audit fix) — exclude, same as ruleTodos below.
  if (file === "scripts/audit-boundaries.ts") return;
  if (CRED_ALLOWED_PREFIXES.some((p) => file.startsWith(p))) return;
  lines.forEach((text, i) => {
    const m = text.match(CRED_RE);
    if (m) {
      add("ERROR", "cred-confine", file, i + 1, `provider credential read outside config/integrations: ${m[0]}`);
    }
    if (/STRIPE_WEBHOOK_SECRET|RAZORPAY_WEBHOOK_SECRET|WHATSAPP_VERIFY_SECRET|EMAIL_WEBHOOK_SECRET/.test(text)) {
      if (WEBHOOK_SECRET_FILES.has(file)) {
        add("INFO", "webhook-secret-vetted", file, i + 1, "gateway verification / demo loopback signer (vetted design)");
      } else {
        add("ERROR", "cred-confine", file, i + 1, "webhook secret read outside vetted gateway paths");
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Rule 3 — no raw SQL outside packages/db.
// ---------------------------------------------------------------------------
const SQL_RE = /\.execute\(\s*sql`|\bpool\.query\s*\(|\bclient\.query\s*\(|new Client\(\s*\{[^}]*connectionString/;
const SQL_ALLOWED_PREFIXES = ["packages/db/", "scripts/"];

function ruleSql(file: string, lines: string[]) {
  if (isTest(file)) return;
  if (SQL_ALLOWED_PREFIXES.some((p) => file.startsWith(p))) return;
  lines.forEach((text, i) => {
    // drizzle `sql`` template *usi* outside db is fine for query *fragments*
    // passed into repos; direct execution is the violation. Heuristic: flag
    // `.execute(` and pool/client query calls only.
    if (/\.execute\(|pool\.query|client\.query/.test(text) && !/redis|Redis|cache/i.test(text)) {
      if (SQL_RE.test(text)) {
        add("ERROR", "sql-confine", file, i + 1, `possible raw SQL execution outside repositories: ${text.trim().slice(0, 120)}`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Rule 4 — TODO/FIXME/HACK must link an issue or step.
// ---------------------------------------------------------------------------
const BARE_MARKER_RE = /\b(TODO|FIXME|HACK|XXX)\b(?!\s*\(#\d+\)|:\s*#\d+|\s+s-\d+|\s*\(s-\d+\))/;

function ruleTodos(file: string, lines: string[]) {
  lines.forEach((text, i) => {
    if (BARE_MARKER_RE.test(text)) {
      // Allow the audit script's own documentation of the rule.
      if (file === "scripts/audit-boundaries.ts") return;
      add("ERROR", "todo-link", file, i + 1, `bare marker without linked issue/step: ${text.trim().slice(0, 120)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Rule 5 — workflow determinism advisory (WARN).
// ---------------------------------------------------------------------------
function ruleDeterminism(file: string, lines: string[]) {
  if (!file.startsWith("services/worker/src/workflows/") || isTest(file)) return;
  lines.forEach((text, i) => {
    if (/Date\.now\(\)|Math\.random\(\)/.test(text)) {
      add("WARN", "workflow-determinism", file, i + 1, `wall-clock/random in workflow code — replay-safety review (see RELEASE-v0.1.0 known limitations): ${text.trim().slice(0, 100)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Rule 6 — process.env outside config (WARN, grandfathered).
// ---------------------------------------------------------------------------
const ENV_ALLOWED_PREFIXES = [
  "packages/config/",
  "scripts/", // gates/ops CLIs read env by design
  "tests/", // harness wiring
];
const ENV_ALLOWED_FILES = new Set([
  "apps/backend/scripts/seed-admin.ts", // bootstrap CLI
  "apps/frontend/src/lib/api.ts", // NEXT_PUBLIC_* public base URL
  "packages/db/drizzle.config.ts", // drizzle-kit CLI (build-time only)
  "packages/db/src/client.ts", // pooled connection bootstrap w/ documented fallback
  "packages/db/src/migrate.ts", // migration CLI entrypoint
  "packages/db/src/seeds/demo.ts", // seed CLI tenant-slug override
]);

function ruleEnv(file: string, lines: string[]) {
  if (isTest(file)) return;
  if (ENV_ALLOWED_PREFIXES.some((p) => file.startsWith(p))) return;
  if (ENV_ALLOWED_FILES.has(file)) {
    lines.forEach((text, i) => {
      if (/process\.env\./.test(text)) {
        add("INFO", "env-vetted", file, i + 1, "bootstrap/edge read (vetted, documented)");
      }
    });
    return;
  }
  lines.forEach((text, i) => {
    if (/process\.env\.[A-Z_]+/.test(text)) {
      add("WARN", "env-confine", file, i + 1, `process.env read outside @repo/config (grandfathered; migrate to typed config): ${text.trim().slice(0, 100)}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
const files = trackedSources();
for (const file of files) {
  const lines = readLines(file);
  if (!lines) continue;
  ruleAiBoundaries(file, lines);
  ruleCreds(file, lines);
  ruleSql(file, lines);
  ruleTodos(file, lines);
  ruleDeterminism(file, lines);
  ruleEnv(file, lines);
}

const errors = findings.filter((f) => f.severity === "ERROR");
const warns = findings.filter((f) => f.severity === "WARN");
const infos = findings.filter((f) => f.severity === "INFO");

console.log(`boundary-audit: scanned ${files.length} tracked source files.`);
console.log(`boundary-audit: ${errors.length} ERROR, ${warns.length} WARN, ${infos.length} INFO.`);
for (const f of findings) {
  const tag = f.severity === "ERROR" ? "FAIL" : f.severity;
  console.log(`boundary-audit: [${tag}] ${f.rule} ${f.file}:${f.line} — ${f.detail}`);
}

if (errors.length > 0) {
  console.error(`boundary-audit: FAIL — ${errors.length} boundary violation(s).`);
  process.exit(1);
}
console.log("boundary-audit: PASS — architectural boundaries hold (warnings tracked, none blocking).");
