import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * s-17 audit fix: AI → adapters boundary rule test (mirrors
 * scripts/audit-boundaries.ts Rule 1, runnable via `bun run test`).
 *
 * No code path may connect the AI module directly to provider adapters:
 * `apps/backend/src/modules/ai/**` must never import `@repo/integrations`,
 * provider SDKs, dispatch Temporal workflows, or invoke execution-layer calls.
 * The full gate remains `bun run boundaries:audit`; this test keeps the
 * s-17 "lint boundary test" requirement green inside the unit suite.
 */
const AI_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "modules",
  "ai",
);

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: "integrations-import", re: /from\s+["']@repo\/integrations[^"']*["']/ },
  { name: "integrations-relpath", re: /packages\/integrations\// },
  {
    name: "provider-sdk",
    re: /require\(["']stripe["']\)|from\s+["']stripe["']|razorpay["']\)/,
  },
  {
    name: "temporal-dispatch",
    re: /workflow\.start\(|signalWithStart\(|getHandle\(/,
  },
  {
    name: "direct-send",
    re: /\.(sendMessage|chargePayment|executePayment|retryPayment)\s*\(/,
  },
];

function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...collectSources(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

describe("AI → adapters boundary (s-17)", () => {
  it("no AI module source reaches provider adapters or execution", () => {
    const violations: string[] = [];
    for (const file of collectSources(AI_DIR)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((text, i) => {
        for (const { name, re } of FORBIDDEN) {
          if (re.test(text)) {
            violations.push(`${file}:${i + 1} [${name}] ${text.trim().slice(0, 120)}`);
          }
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
