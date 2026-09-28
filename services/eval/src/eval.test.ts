import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { EvalRunner } from "./runner";
import { getPrompt } from "../../../apps/backend/src/modules/ai/prompts/registry";
import { validateStructural } from "../../../apps/backend/src/modules/ai/validate/structural";
import { validateSemantic } from "../../../apps/backend/src/modules/ai/validate/semantic";

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

  it("3. Renders a real prompt template through structural+semantic validation (not the simulator)", async () => {
    // s-15 MED fix: the gate above exercises the deterministic offline
    // simulator, so a prompt-template regression (renamed version, emptied
    // system prompt, broken buildUserPrompt) would go unnoticed. This test
    // renders the checked-in template for a real golden case and pushes a
    // hand-built candidate through the production validators.
    const raw = fs.readFileSync(datasetPath, "utf8");
    const cases = JSON.parse(raw) as Array<{
      surface: "PAYMENT_FAILURE" | "INVOICE_OVERDUE" | "CHECKOUT_ABANDONMENT";
      input_snapshot: {
        recovery_case: Record<string, unknown>;
        risk: Record<string, unknown>;
        customer_context: Record<string, unknown>;
      };
      expect: {
        should_actions_any_of: string[][];
        cause_one_of: string[];
      };
    }>;
    const first = cases[0]!;

    const prompt = getPrompt(first.surface);
    expect(prompt.version).toMatch(/.+@\d+/);
    expect(prompt.systemPrompt.length).toBeGreaterThan(100);
    expect(prompt.allowedActions.length).toBeGreaterThan(0);

    const userPrompt = prompt.buildUserPrompt(first.input_snapshot);
    expect(userPrompt).toContain("RECOVERY CASE");
    expect(userPrompt).toContain(String(first.input_snapshot.recovery_case["id"]));

    const actionType = first.expect.should_actions_any_of[0]?.[0] ?? prompt.allowedActions[0]!;
    const candidate: Record<string, unknown> = {
      diagnosis: {
        cause: first.expect.cause_one_of[0] ?? "unknown",
        confidence: 0.85,
        rationale: "CI real-template render check",
      },
      actions: [
        actionType === "RETRY_PAYMENT"
          ? { type: actionType, delay_hours: 24, rationale: "CI check" }
          : { type: actionType, rationale: "CI check" },
      ],
      stop_conditions: ["PAYMENT_SUCCEEDED"],
    };

    const struct = validateStructural(candidate);
    expect(struct.valid).toBe(true);
    expect(struct.data).not.toBeNull();
    const sem = validateSemantic(struct.data!, first.surface);
    expect(sem.valid).toBe(true);
  });
});
