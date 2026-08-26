import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOTS = ["docs", "specs/steps", "."];

function collectMarkdown(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".git")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectMarkdown(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
let broken = 0;
let checked = 0;

for (const root of ROOTS) {
  if (!existsSync(root)) continue;
  const files = root === "." ? ["README.md"] : collectMarkdown(root);
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const match of content.matchAll(LINK)) {
      const target = match[1];
      if (/^(https?:|mailto:|#)/i.test(target)) continue;
      checked++;
      const path = target.split("#")[0];
      if (path && !existsSync(resolve(dirname(file), path))) {
        console.error(`BROKEN: ${file} -> ${target}`);
        broken++;
      }
    }
  }
}

console.log(`Checked ${checked} relative links across ${ROOTS.join(", ")}.`);
if (broken > 0) {
  console.error(`${broken} broken link(s) found.`);
  process.exit(1);
}
console.log("All doc links OK.");
