#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { EvalRunner } from "./runner";

/**
 * AI Quality Evaluation CLI Runner (Step 15 §3, Spec 01 §20).
 * Replays golden datasets against prompt versions, outputs metrics, and gates CI.
 */
async function main() {
  const args = process.argv.slice(2);
  let datasetPath = path.resolve(
    process.cwd(),
    "services/eval/src/datasets/golden-v1.json",
  );
  if (!fs.existsSync(datasetPath)) {
    datasetPath = path.resolve(__dirname, "datasets/golden-v1.json");
  }
  let promptVersion: string | undefined;
  let outPath: string | undefined;
  let mock = true; // Default to true in CLI when no external API key is provided
  let tamper = false;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const val = args[i + 1];
    if (flag === "--dataset" && val) {
      datasetPath = path.resolve(val);
      i++;
    } else if (flag === "--prompt-version" && val) {
      promptVersion = val;
      i++;
    } else if (flag === "--out" && val) {
      outPath = path.resolve(val);
      i++;
    } else if (flag === "--mock") {
      mock = true;
    } else if (flag === "--live") {
      mock = false;
    } else if (flag === "--tamper") {
      tamper = true;
    }
  }

  console.log(`[Eval Runner] Starting evaluation on dataset: ${datasetPath}`);
  console.log(`[Eval Runner] Prompt Version Override: ${promptVersion || "default"}`);
  console.log(`[Eval Runner] Execution Mode: ${mock ? "Deterministic Mock / Replay" : "Live API Inference"}`);

  const report = await EvalRunner.runEvaluation({
    datasetPath,
    promptVersionOverride: promptVersion,
    tamperPromptForTesting: tamper,
    mockDeterministic: mock,
  });

  const markdown = EvalRunner.generateMarkdownTable(report);
  console.log("\n" + markdown);

  if (outPath) {
    if (outPath.endsWith(".json")) {
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
    } else {
      fs.writeFileSync(outPath, markdown, "utf8");
    }
    console.log(`[Eval Runner] Report written to: ${outPath}`);
  }

  if (!report.passed) {
    console.error(`\n❌ [Eval Gate Failed] Schema validity (${(report.schema_validity_rate * 100).toFixed(1)}%) < 95% or Must-Not violations (${report.must_not_violations}) > 0`);
    process.exit(1);
  } else {
    console.log(`\n✅ [Eval Gate Passed] Prompt version meets all safety, schema validity and distribution criteria.`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Unhandled error in Eval Runner:", err);
  process.exit(1);
});
