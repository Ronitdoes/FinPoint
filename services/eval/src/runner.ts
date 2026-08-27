import fs from "node:fs";
import path from "node:path";
import type { RiskType } from "@repo/domain";
import { getPrompt, type PromptDefinition } from "../../../apps/backend/src/modules/ai/prompts/registry";
import { validateStructural } from "../../../apps/backend/src/modules/ai/validate/structural";
import { validateSemantic } from "../../../apps/backend/src/modules/ai/validate/semantic";
import { computeCostMinorUnits, parseTokenUsage } from "../../../apps/backend/src/modules/ai/governance/pricing";
import { LlmClient } from "../../../apps/backend/src/modules/ai/llm/client";
import { StructuredCompletionService } from "../../../apps/backend/src/modules/ai/llm/structured";

export interface GoldenCaseExpect {
  must_not_actions: string[];
  should_actions_any_of: string[][];
  min_confidence: number;
  cause_one_of: string[];
}

export interface GoldenCase {
  case_ref: string;
  surface: RiskType;
  input_snapshot: {
    recovery_case: Record<string, unknown>;
    risk: Record<string, unknown>;
    customer_context: Record<string, unknown>;
  };
  expect: GoldenCaseExpect;
}

export interface CaseEvalResult {
  case_ref: string;
  surface: RiskType;
  prompt_version: string;
  schema_valid: boolean;
  semantic_valid: boolean;
  must_not_violation: boolean;
  violated_actions: string[];
  should_actions_met: boolean;
  cause_matched: boolean;
  confidence_met: boolean;
  diagnosis: {
    cause: string;
    confidence: number;
  };
  actions: string[];
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_minor_units: bigint;
  error?: string;
}

export interface EvalSummaryReport {
  timestamp: string;
  dataset: string;
  total_cases: number;
  schema_validity_rate: number;
  semantic_validity_rate: number;
  must_not_violations: number;
  should_actions_met_rate: number;
  cause_match_rate: number;
  confidence_met_rate: number;
  mean_confidence: number;
  mean_latency_ms: number;
  total_cost_minor_units: number;
  action_distribution: Record<string, number>;
  passed: boolean;
  case_results: CaseEvalResult[];
}

export interface EvalRunOptions {
  datasetPath: string;
  promptVersionOverride?: string;
  tamperPromptForTesting?: boolean;
  customFetch?: typeof fetch;
  mockDeterministic?: boolean;
  model?: string;
}

export class EvalRunner {
  /**
   * Replays golden dataset cases against prompts WITHOUT executing actions (purpose: 'EVAL').
   */
  public static async runEvaluation(options: EvalRunOptions): Promise<EvalSummaryReport> {
    const {
      datasetPath,
      promptVersionOverride,
      tamperPromptForTesting = false,
      customFetch,
      mockDeterministic = false,
      model = "gpt-4o",
    } = options;

    const rawData = fs.readFileSync(path.resolve(datasetPath), "utf8");
    const goldenCases: GoldenCase[] = JSON.parse(rawData);

    const client = new LlmClient({ model, timeoutMs: 15000, maxRetries: 1 });
    const structuredService = new StructuredCompletionService(client);

    const caseResults: CaseEvalResult[] = [];
    const actionDistribution: Record<string, number> = {};

    let totalLatencyMs = 0;
    let totalConfidence = 0;
    let totalCostMinor = 0n;

    for (const item of goldenCases) {
      const surface = item.surface;
      let promptDef: PromptDefinition = getPrompt(surface);

      if (promptVersionOverride) {
        promptDef = { ...promptDef, version: promptVersionOverride };
      }

      let decisionResult: any;
      let latencyMs = 25;
      let inputTokens = 250;
      let outputTokens = 80;
      let costMinor = 0n;

      if (mockDeterministic || customFetch) {
        if (customFetch) {
          try {
            const res = await structuredService.generateDecision({
              prompt: promptDef,
              snapshot: item.input_snapshot as any,
              model,
              customFetch,
            });
            decisionResult = res.parsedJson;
            latencyMs = res.latencyMs;
            inputTokens = res.inputTokens;
            outputTokens = res.outputTokens;
            costMinor = res.costMinorUnits;
          } catch (err: any) {
            decisionResult = null;
          }
        } else {
          // Pure deterministic fallback simulator for offline CI
          decisionResult = EvalRunner.simulateMockCompletion(item, tamperPromptForTesting);
          costMinor = computeCostMinorUnits({ inputTokens, outputTokens }, model);
        }
      } else {
        try {
          const res = await structuredService.generateDecision({
            prompt: promptDef,
            snapshot: item.input_snapshot as any,
            model,
          });
          decisionResult = res.parsedJson;
          latencyMs = res.latencyMs;
          inputTokens = res.inputTokens;
          outputTokens = res.outputTokens;
          costMinor = res.costMinorUnits;
        } catch (err: any) {
          decisionResult = null;
        }
      }

      // If intentionally testing tampered prompt, force bad actions
      if (tamperPromptForTesting && decisionResult) {
        decisionResult = {
          ...decisionResult,
          actions: [{ type: "OFFER_INCENTIVE", params: { discount_pct: 75 } }],
        };
      }

      // 1. Structural Validation
      const structValidation = validateStructural(decisionResult);
      const schemaValid = structValidation.valid;

      // 2. Semantic Validation
      let semanticValid = false;
      if (schemaValid && structValidation.data) {
        const semValidation = validateSemantic(structValidation.data, surface);
        semanticValid = semValidation.valid;
      }

      // 3. Evaluate Assertions
      const diagnosisCause = decisionResult?.diagnosis?.cause || "unknown";
      const confidence = Number(decisionResult?.diagnosis?.confidence ?? 0);
      const generatedActions: string[] = Array.isArray(decisionResult?.actions)
        ? decisionResult.actions.map((a: any) => (typeof a === "string" ? a : a?.type || ""))
        : [];

      // Update action distribution
      for (const act of generatedActions) {
        if (act) {
          actionDistribution[act] = (actionDistribution[act] || 0) + 1;
        }
      }

      // Must-not check
      const violatedActions = generatedActions.filter((a) =>
        item.expect.must_not_actions.includes(a),
      );
      const mustNotViolation = violatedActions.length > 0;

      // Should-actions check
      let shouldActionsMet = item.expect.should_actions_any_of.length === 0;
      for (const candidateGroup of item.expect.should_actions_any_of) {
        if (candidateGroup.some((candidate) => generatedActions.includes(candidate))) {
          shouldActionsMet = true;
          break;
        }
      }

      // Cause match check
      const causeMatched =
        item.expect.cause_one_of.length === 0 ||
        item.expect.cause_one_of.includes(diagnosisCause);

      // Confidence check
      const confidenceMet = confidence >= item.expect.min_confidence;

      totalLatencyMs += latencyMs;
      totalConfidence += confidence;
      totalCostMinor += costMinor;

      caseResults.push({
        case_ref: item.case_ref,
        surface,
        prompt_version: promptDef.version,
        schema_valid: schemaValid,
        semantic_valid: semanticValid,
        must_not_violation: mustNotViolation,
        violated_actions: violatedActions,
        should_actions_met: shouldActionsMet,
        cause_matched: causeMatched,
        confidence_met: confidenceMet,
        diagnosis: {
          cause: diagnosisCause,
          confidence,
        },
        actions: generatedActions,
        latency_ms: latencyMs,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_minor_units: costMinor,
      });
    }

    const n = goldenCases.length || 1;
    const schemaValidCount = caseResults.filter((c) => c.schema_valid).length;
    const semanticValidCount = caseResults.filter((c) => c.semantic_valid).length;
    const mustNotViolationsCount = caseResults.filter((c) => c.must_not_violation).length;
    const shouldActionsMetCount = caseResults.filter((c) => c.should_actions_met).length;
    const causeMatchCount = caseResults.filter((c) => c.cause_matched).length;
    const confidenceMetCount = caseResults.filter((c) => c.confidence_met).length;

    const schemaValidityRate = schemaValidCount / n;
    const semanticValidityRate = semanticValidCount / n;
    const shouldActionsMetRate = shouldActionsMetCount / n;
    const causeMatchRate = causeMatchCount / n;
    const confidenceMetRate = confidenceMetCount / n;
    const meanConfidence = totalConfidence / n;
    const meanLatencyMs = Math.round(totalLatencyMs / n);

    // Gate condition: Schema validity >= 95% AND 0 must_not violations
    const passed = schemaValidityRate >= 0.95 && mustNotViolationsCount === 0;

    return {
      timestamp: new Date().toISOString(),
      dataset: datasetPath,
      total_cases: n,
      schema_validity_rate: Number(schemaValidityRate.toFixed(4)),
      semantic_validity_rate: Number(semanticValidityRate.toFixed(4)),
      must_not_violations: mustNotViolationsCount,
      should_actions_met_rate: Number(shouldActionsMetRate.toFixed(4)),
      cause_match_rate: Number(causeMatchRate.toFixed(4)),
      confidence_met_rate: Number(confidenceMetRate.toFixed(4)),
      mean_confidence: Number(meanConfidence.toFixed(4)),
      mean_latency_ms: meanLatencyMs,
      total_cost_minor_units: Number(totalCostMinor),
      action_distribution: actionDistribution,
      passed,
      case_results: caseResults,
    };
  }

  public static generateMarkdownTable(report: EvalSummaryReport): string {
    const lines: string[] = [];
    lines.push("# AI Decision Quality Evaluation Report");
    lines.push("");
    lines.push(`**Evaluation Date**: ${report.timestamp}  `);
    lines.push(`**Dataset**: \`${report.dataset}\` (${report.total_cases} golden cases)  `);
    lines.push(`**Overall Gate Status**: ${report.passed ? "✅ **PASSED**" : "❌ **FAILED (GATE VIOLATION)**"}`);
    lines.push("");
    lines.push("### Summary Metrics");
    lines.push("");
    lines.push("| Metric | Result | Target / Gate |");
    lines.push("|---|---|---|");
    lines.push(`| **Schema Validity Rate** | ${(report.schema_validity_rate * 100).toFixed(1)}% | $\\ge$ 95.0% |`);
    lines.push(`| **Semantic Validity Rate** | ${(report.semantic_validity_rate * 100).toFixed(1)}% | $\\ge$ 95.0% |`);
    lines.push(`| **Must-Not Action Violations** | ${report.must_not_violations} | **0** |`);
    lines.push(`| **Should-Actions Met Rate** | ${(report.should_actions_met_rate * 100).toFixed(1)}% | $\\ge$ 80.0% |`);
    lines.push(`| **Cause Match Rate** | ${(report.cause_match_rate * 100).toFixed(1)}% | $\\ge$ 80.0% |`);
    lines.push(`| **Mean Confidence** | ${(report.mean_confidence * 100).toFixed(1)}% | -- |`);
    lines.push(`| **Mean Latency** | ${report.mean_latency_ms} ms | < 2,500 ms |`);
    lines.push(`| **Total Est. Cost** | ₹${(report.total_cost_minor_units / 100).toFixed(2)} | -- |`);
    lines.push("");
    lines.push("### Action Distribution Drift");
    lines.push("");
    lines.push("| Action | Frequency | Percentage |");
    lines.push("|---|---|---|");
    const totalActs = Object.values(report.action_distribution).reduce((a, b) => a + b, 0) || 1;
    for (const [action, count] of Object.entries(report.action_distribution)) {
      lines.push(`| \`${action}\` | ${count} | ${((count / totalActs) * 100).toFixed(1)}% |`);
    }
    lines.push("");

    return lines.join("\n");
  }

  private static simulateMockCompletion(item: GoldenCase, tamper = false): any {
    if (tamper) {
      return {
        diagnosis: {
          cause: "unknown",
          confidence: 0.9,
          rationale: "Tampered test simulation",
        },
        actions: [
          {
            type: "OFFER_INCENTIVE",
            rationale: "Unauthorized incentive offer",
            params: { discount_pct: 80 },
          },
        ],
        stop_conditions: ["PAYMENT_SUCCEEDED"],
      };
    }

    if (item.surface === "PAYMENT_FAILURE") {
      const cause = item.expect.cause_one_of[0] || "insufficient_funds";
      return {
        diagnosis: {
          cause,
          confidence: 0.88,
          rationale: "Customer card decline diagnosis from baseline prompt.",
        },
        actions: [
          {
            type: item.expect.should_actions_any_of[0]?.[0] || "RETRY_PAYMENT",
            delay_hours: 24,
            rationale: "Scheduled retry.",
          },
        ],
        stop_conditions: ["PAYMENT_SUCCEEDED", "MAX_RETRIES", "OPTED_OUT"],
      };
    }

    if (item.surface === "INVOICE_OVERDUE") {
      const cause = item.expect.cause_one_of[0] || "waiting_for_payday";
      return {
        diagnosis: {
          cause,
          confidence: 0.85,
          rationale: "Overdue invoice follow up from baseline prompt.",
        },
        actions: [
          {
            type: item.expect.should_actions_any_of[0]?.[0] || "SEND_EMAIL",
            rationale: "Friendly invoice reminder.",
            params: { template: "invoice_reminder_gentle" },
          },
        ],
        stop_conditions: ["PAYMENT_SUCCEEDED", "PROMISE_CREATED", "OPTED_OUT"],
      };
    }

    // CHECKOUT_ABANDONMENT
    const cause = item.expect.cause_one_of[0] || "distraction";
    return {
      diagnosis: {
        cause,
        confidence: 0.82,
        rationale: "Checkout abandonment re-engagement from baseline prompt.",
      },
      actions: [
        {
          type: item.expect.should_actions_any_of[0]?.[0] || "SEND_WHATSAPP",
          rationale: "Cart recovery message.",
          params: { template: "cart_recovery_whatsapp" },
        },
      ],
      stop_conditions: ["PAYMENT_SUCCEEDED", "OPTED_OUT"],
    };
  }
}
