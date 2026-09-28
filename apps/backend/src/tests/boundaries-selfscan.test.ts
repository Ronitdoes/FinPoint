/**
 * Boundaries self-scan regression (s-35 audit fix).
 *
 * `scripts/audit-boundaries.ts` necessarily names provider-credential
 * literals inside its own CRED_RE / webhook-secret patterns. Without a
 * self-scan guard, ruleCreds flags its own definition lines
 * (STRIPE_SECRET_KEY on the CRED_RE line, webhook secrets on the vetted
 * regex line) as `cred-confine` ERRORs — a false positive that fails the
 * gate with 2 ERRORs on a clean tree.
 *
 * Guard: `ruleCreds` early-returns for `scripts/audit-boundaries.ts`,
 * mirroring the existing `ruleTodos` self-exclusion. This test pins that
 * guard and proves the gate runs green end-to-end.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const SCRIPT_REL = "scripts/audit-boundaries.ts";

function readScript(): string {
  return readFileSync(join(REPO_ROOT, SCRIPT_REL), "utf8");
}

describe("boundaries self-scan guard (s-35 audit fix)", () => {
  it("ruleCreds excludes its own script file (self-scan guard present)", () => {
    const src = readScript();
    // The guard must live inside ruleCreds, not just anywhere in the file
    // (ruleTodos has its own separate exclusion).
    const ruleCredsBlock = src.split("function ruleCreds")[1]?.split("function ruleSql")[0] ?? "";
    expect(ruleCredsBlock).toContain('scripts/audit-boundaries.ts');
    expect(ruleCredsBlock).toMatch(/return/);
  });

  it("gate patterns are still intact (guard did not neuter the rule)", () => {
    const src = readScript();
    // Provider-credential families must still be detected.
    expect(src).toContain("STRIPE_SECRET_KEY");
    expect(src).toContain("RAZORPAY_KEY_SECRET");
    expect(src).toContain("STRIPE_WEBHOOK_SECRET");
    expect(src).toContain("cred-confine");
  });

  it("bun run boundaries:audit passes with 0 ERROR (no self-flag)", () => {
    const out = execFileSync("bun", [SCRIPT_REL], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out).toMatch(/0 ERROR/);
    expect(out).toContain("PASS");
    // The script must never flag itself.
    expect(out).not.toMatch(/FAIL.*scripts\/audit-boundaries\.ts/);
  });
});
