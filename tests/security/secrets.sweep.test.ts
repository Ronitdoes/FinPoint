/**
 * Secrets sweep verification (Step 30 §Requirements 2).
 *
 * Two layers:
 *  1. Gate integrity — the CI script `scripts/security-sweep.mjs` declares
 *     every step-mandated pattern family and fails closed (exit 1) with
 *     docker-context hygiene checks.
 *  2. Live hygiene — `.env.example` carries placeholder-shaped values only,
 *     both `.dockerignore` files exclude `.env*`, the local
 *     `infra/docker/.env` (real dev credential) is untracked, and the built
 *     frontend bundle (when present) contains no live-shaped secrets.
 *
 * The in-test scanner below mirrors the CI script's semantics; the script
 * itself is canonical (see its header comment).
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "stripe_live_secret", regex: /sk_live_[A-Za-z0-9]{8,}/g },
  { name: "stripe_test_secret", regex: /sk_test_[A-Za-z0-9]{8,}/g },
  { name: "webhook_secret", regex: /whsec_[A-Za-z0-9]{8,}/g },
  { name: "razorpay_key", regex: /rzp_(?:live|test)_[A-Za-z0-9]{4,}/g },
  { name: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "private_key", regex: /BEGIN (?:RSA )?PRIVATE KEY/g },
  { name: "neon_key", regex: /npg_[A-Za-z0-9]{8,}/g },
  { name: "revenue_api_key", regex: /rrk_[A-Za-z0-9_]{12,}/g },
];

const PLACEHOLDER_HINT =
  /(\.\.\.|xxx|\*\*\*|your-|example|changeme|placeholder|test_override|evil_key|secret|integration|fixture|synthetic|dummy)/i;

function scanText(text: string): string[] {
  const hits: string[] = [];
  for (const { regex } of PATTERNS) {
    regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (!PLACEHOLDER_HINT.test(m[0])) {
        hits.push(m[0]);
      }
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
  }
  return hits;
}

describe("secrets.sweep: CI gate integrity", () => {
  const scriptPath = join(REPO_ROOT, "scripts/security-sweep.mjs");
  const script = readFileSync(scriptPath, "utf8");

  it("declares every step-mandated pattern family", () => {
    for (const prefix of [
      "sk_live",
      "sk_test",
      "whsec",
      "rzp_",
      "AKIA",
      "BEGIN PRIVATE KEY",
    ]) {
      expect(
        script.includes(prefix),
        `sweep script must cover pattern ${prefix}`,
      ).toBe(true);
    }
  });

  it("fails closed and checks docker contexts", () => {
    expect(script.includes("process.exit(1)")).toBe(true);
    expect(script.includes(".dockerignore")).toBe(true);
    expect(script.includes("git ls-files")).toBe(true);
    expect(script.includes(".next")).toBe(true);
  });

  it("guards app.allow_audit_delete setter to reset.ts + 0010 only", () => {
    expect(script.includes("allow_audit_delete")).toBe(true);
    expect(script.includes("audit_delete_hatch")).toBe(true);
    expect(script.includes("packages/db/src/seeds/reset.ts")).toBe(true);
    expect(script.includes("0010_audit_reset_hatch.sql")).toBe(true);
  });

  it("catches live-shaped values but ignores placeholders", () => {
    expect(scanText("key=sk_live_4eC39HqLyjWDarjtT1zdp7dc")).toHaveLength(1);
    expect(scanText("key=sk_test_51H7xYZabcDEF123456")).toHaveLength(1);
    expect(scanText("secret=whsec_a1b2c3d4e5f6g7h8")).toHaveLength(1);
    expect(scanText("id=rzp_live_kH3f9d2sA1b7Xz")).toHaveLength(1);
    expect(scanText("aws=AKIA4M3X7K9Q2W8E5RTYZ")).toHaveLength(1);
    expect(scanText("k=npg_A1b2C3d4E5f6G7h8J9k0Lm")).toHaveLength(1);
    expect(scanText("-----BEGIN PRIVATE KEY-----")).toHaveLength(1);
    // Placeholders from .env.example / docs / fixtures stay quiet.
    expect(scanText('STRIPE_SECRET_KEY="sk_test_..."')).toHaveLength(0);
    expect(scanText('STRIPE_WEBHOOK_SECRET="whsec_..."')).toHaveLength(0);
    expect(scanText('RAZORPAY_KEY_ID="rzp_test_..."')).toHaveLength(0);
    expect(scanText("key=rzp_test_secret")).toHaveLength(0);
    expect(scanText("key=rrk_live_super_secret_key_12345")).toHaveLength(0);
  });
});

describe("secrets.sweep: live repo hygiene", () => {
  it(".env.example carries placeholder-shaped values only", () => {
    const example = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    expect(scanText(example)).toEqual([]);
  });

  it("docker contexts exclude local env files and git metadata", () => {
    for (const rel of [".dockerignore", "infra/docker/.dockerignore"]) {
      const abs = join(REPO_ROOT, rel);
      expect(existsSync(abs), `${rel} must exist`).toBe(true);
      const content = readFileSync(abs, "utf8");
      expect(content).toMatch(/^\.env\*/m);
      expect(content).toMatch(/\.git/);
    }
  });

  it("local infra/docker/.env with the real dev credential is untracked", () => {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim());
    expect(tracked).toContain(".env.example");
    expect(tracked).not.toContain("infra/docker/.env");
    expect(tracked.filter((f) => /(^|\/)\.env$/.test(f))).toEqual([]);
  });

  it("app.allow_audit_delete is SET only in reset.ts (+0010 allowlisted)", () => {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const setter = /SET\s+(LOCAL\s+)?app\.allow_audit_delete/i;
    const offenders: string[] = [];
    for (const rel of tracked) {
      if (
        rel === "packages/db/src/seeds/reset.ts" ||
        rel === "packages/db/drizzle/0010_audit_reset_hatch.sql"
      ) {
        continue;
      }
      if (!/\.(ts|js|mjs|cjs|sql)$/.test(rel)) continue;
      const abs = join(REPO_ROOT, rel);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, "utf8");
      if (setter.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("built frontend bundle contains no live-shaped secrets (when built)", () => {
    const staticDir = join(REPO_ROOT, "apps/frontend/.next/static");
    if (!existsSync(staticDir)) {
      return;
    }
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (/\.(js|json|html|css)$/.test(name) && st.size <= 5 * 1024 * 1024) {
          files.push(p);
        }
      }
    };
    walk(staticDir);
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files.slice(0, 200)) {
      const text = readFileSync(file, "utf8");
      for (const hit of scanText(text)) {
        hits.push(`${file}: ${hit.slice(0, 16)}...`);
      }
    }
    expect(hits).toEqual([]);
  });
});
