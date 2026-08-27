import { describe, it, expect } from "vitest";
import path from "node:path";
import { EvalRunner } from "./runner";

describe("Step 15 — AI Quality Evaluation Harness", () => {
  const datasetPath = path.resolve(__dirname, "datasets/golden-v1.json");

  it("1. Replays golden-v1 dataset against baseline prompts and passes evaluation gate", async () => {
    const report = await EvalRunner.runEvaluation({
      datasetPath,
      mockDeterministic: true,
    });

    expect(report.total_cases).toBe(30);
    expect(report.schema_validity_rate).toBeGreaterThanOrEqual(0.95);
    expect(report.semantic_validity_rate).toBeGreaterThanOrEqual(0.95);
    expect(report.must_not_violations).toBe(0);
    expect(report.should_actions_met_rate).toBeGreaterThanOrEqual(0.8);
    expect(report.passed).toBe(true);
    expect(report.action_distribution).toBeDefined();

    const markdown = EvalRunner.generateMarkdownTable(report);
    expect(markdown).toContain("AI Decision Quality Evaluation Report");
    expect(markdown).toContain("✅ **PASSED**");
  });

  it("2. Tampered prompt violating must_not rules triggers gate failure and non-zero exit condition", async () => {
    const report = await EvalRunner.runEvaluation({
      datasetPath,
      mockDeterministic: true,
      tamperPromptForTesting: true,
    });

    expect(report.must_not_violations).toBeGreaterThan(0);
    expect(report.passed).toBe(false);

    const markdown = EvalRunner.generateMarkdownTable(report);
    expect(markdown).toContain("❌ **FAILED (GATE VIOLATION)**");
  });
});
