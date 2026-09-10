/**
 * §29 coverage marker audit (s-32 §Tests).
 *
 * Counts distinct [DOD-NN] markers across tests/e2e and fails if <18.
 * Also verifies all 7 spec 03 §8 acceptance titles (AC-PAY-1..4, AC-CO-1..2,
 * AC-INV-1) exist. Run: `bun scripts/e2e-coverage-check.mjs`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "tests/e2e";

function collect(dir, exts) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collect(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const files = collect(ROOT, [".ts"]);
const dod = new Set();
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const m of content.matchAll(/\[DOD-(\d{2})\]/g)) dod.add(m[1]);
}

const missing = [];
for (let i = 1; i <= 18; i++) {
  const key = String(i).padStart(2, "0");
  if (!dod.has(key)) missing.push(`DOD-${key}`);
}

const REQUIRED_AC = ["AC-PAY-1", "AC-PAY-2", "AC-PAY-3", "AC-PAY-4", "AC-CO-1", "AC-CO-2", "AC-INV-1"];
const corpus = files.map((f) => readFileSync(f, "utf8")).join("\n");
const missingAc = REQUIRED_AC.filter((ac) => !corpus.includes(ac));

console.log(`§29 markers found: ${dod.size}/18 (${[...dod].sort().join(", ") || "none"})`);
console.log(`Acceptance titles found: ${REQUIRED_AC.length - missingAc.length}/7`);
if (missing.length > 0) console.error(`MISSING §29 markers: ${missing.join(", ")}`);
if (missingAc.length > 0) console.error(`MISSING acceptance blocks: ${missingAc.join(", ")}`);

if (missing.length > 0 || missingAc.length > 0 || dod.size < 18) {
  console.error("E2E coverage audit FAILED");
  process.exit(1);
}
console.log("E2E coverage audit PASSED: 18/18 §29 items + 7/7 §8 blocks");
