import type Redis from "ioredis";
import type { Database } from "@repo/db";
import type { Repositories } from "../../plugins/db";
import type { ServerConfig } from "@repo/config";
import type { RiskType } from "@repo/domain";
import { getLogger, recordLlmCall, recordFallback } from "@repo/observability";
import {
  CaseNotFoundError,
  ConflictError,
  ContextInvalidError,
  ConfigurationError,
  IdempotencyInFlightError,
  IdempotencyKeyReusedError,
} from "../../lib/errors";
import { sha256 } from "../../lib/crypto";
import { CustomerContextService } from "../customers/customer-context.service";
import { getPrompt, type PromptDefinition } from "./prompts/registry";
import {
  LlmClient,
  LlmTimeoutError,
  LlmRateLimitError,
  LlmTransportError,
} from "./llm/client";
import { StructuredCompletionService } from "./llm/structured";
import { validateStructural } from "./validate/structural";
import { validateSemantic } from "./validate/semantic";
import { generateFallbackDecision } from "./validate/fallback";
import type { DecisionRecord } from "./schemas/decision";
import { defaultCircuitBreaker } from "./llm/circuit-breaker";
import { MODEL_PRICING_TABLE, computeCostMinorUnits } from "./governance/pricing";

const logger = getLogger({ component: "ai-decide-service" });

export interface DecideOptions {
  tenantId: string;
  caseId: string;
  riskId?: string;
  purpose?: "CASE_OPENING" | "REPLAN" | "EVAL";
  idempotencyKey?: string;
  db: Database;
  repos: Repositories;
  redis?: Redis | null;
  config: ServerConfig;
  customFetch?: typeof fetch;
}

export interface DecisionResponse {
  decisionId: string;
  caseId: string;
  status: "COMPLETED" | "FALLBACK_RULE_BASED";
  diagnosis: {
    cause: string;
    confidence: number;
    rationale: string;
  };
  actions: unknown[];
  stop_conditions: string[];
  latency_ms: number;
  model: string;
  prompt_version: string;
  fallback?: boolean;
}

export class AiDecideService {
  /**
   * Orchestrates the complete AI decision pipeline:
   * Case verification -> Context gathering & safety validation -> Versioned prompt lookup ->
   * Structured LLM inference (with timeout/retries/circuit breaker) ->
   * Multi-stage validation -> Repair retry -> Deterministic fallback ->
   * In-transaction decision row and cost ledger entry persistence.
   */
  public static async decide(options: DecideOptions): Promise<DecisionResponse> {
    const {
      tenantId,
      caseId,
      riskId,
      purpose = "CASE_OPENING",
      idempotencyKey,
      db,
      repos,
      redis,
      config,
      customFetch,
    } = options;

    const requestPayload = { caseId, riskId, purpose };
    let compositeKey: string | undefined;

    // 0. Model Pricing Pre-validation: fail CLOSED if model is unconfigured (Step 15 §Reliability)
    const configuredModel = config.ai.model || "gpt-4o";
    if (!MODEL_PRICING_TABLE[configuredModel]) {
      throw new ConfigurationError(
        `Unknown LLM model '${configuredModel}' has no configured pricing table entry`,
        { model: configuredModel, supportedModels: Object.keys(MODEL_PRICING_TABLE) },
      );
    }

    // 1. Idempotency handling
    if (idempotencyKey) {
      compositeKey = `${tenantId}:${idempotencyKey}`;
      const requestHash = sha256(JSON.stringify(requestPayload));

      const existingSnapshot = await repos.getResponseSnapshot(
        { db },
        { key: compositeKey },
      );
      if (existingSnapshot) {
        return existingSnapshot as unknown as DecisionResponse;
      }

      const acquireResult = await repos.tryAcquire(
        { db },
        { key: compositeKey, requestHash, ttlSeconds: 60 },
      );

      if (acquireResult === "IN_FLIGHT") {
        const snapshot = await repos.getResponseSnapshot(
          { db },
          { key: compositeKey },
        );
        if (snapshot) {
          return snapshot as unknown as DecisionResponse;
        }
        throw new IdempotencyInFlightError();
      } else if (acquireResult === "COMPLETED_DIFFERENT") {
        throw new IdempotencyKeyReusedError();
      }
    }

    // 2. Load Recovery Case
    const recoveryCase = await repos.findCaseById({ db }, { tenantId, caseId });
    if (!recoveryCase) {
      throw new CaseNotFoundError(`Recovery case '${caseId}' not found`);
    }

    // Check terminal case
    const terminalStatuses = ["RECOVERED", "STOPPED", "RESOLVED_UPSTREAM"];
    if (terminalStatuses.includes(recoveryCase.status)) {
      throw new ConflictError(
        `Recovery case is in terminal state '${recoveryCase.status}'`,
        "CASE_TERMINAL",
      );
    }

    // 3. Resolve Risk Record
    let riskRecord: any = null;
    if (riskId) {
      riskRecord = await repos.findRevenueRiskById(
        { db },
        { tenantId, riskId },
      );
    }
    if (!riskRecord) {
      const risks = await repos.listRisks(
        { db },
        { tenantId, customerId: recoveryCase.customerId ?? undefined, limit: 1 },
      );
      riskRecord = risks.items[0] ?? null;
    }

    // 4. Gather Allowlisted Customer Context (s-13)
    const customerContext = await CustomerContextService.buildForCase({
      tenantId,
      caseId,
      purpose: "ai_decision",
      db,
      repos,
      redis,
    });

    // Validate Context Fields completeness before invoking LLM (Step 15 Adversarial Test 7)
    if (
      !recoveryCase.id ||
      !recoveryCase.riskType ||
      recoveryCase.amountAtRisk === undefined ||
      recoveryCase.amountAtRisk === null ||
      !customerContext ||
      !customerContext.customer?.id ||
      !customerContext.recovery_history
    ) {
      throw new ContextInvalidError(
        "Mandatory context fields missing for AI decisioning",
        { caseId, hasCustomerContext: Boolean(customerContext) },
      );
    }

    // 5. Assemble Redacted Input Snapshot (Spec 01 §10)
    const inputSnapshot = {
      recovery_case: {
        id: recoveryCase.id,
        risk_type: recoveryCase.riskType,
        amount_at_risk: Number(recoveryCase.amountAtRisk),
        currency: recoveryCase.currency,
        status: recoveryCase.status,
        opened_at: recoveryCase.openedAt?.toISOString(),
      },
      risk: {
        id: riskRecord?.id ?? null,
        score: riskRecord?.score ?? recoveryCase.riskScore,
        band: riskRecord?.band ?? "MEDIUM",
        factors: riskRecord?.factors ?? [],
      },
      customer_context: customerContext,
    };

    // 6. Resolve Prompt Definition
    const prompt = getPrompt(recoveryCase.riskType as RiskType);

    // 7. Setup LLM Client and Structured Transport
    const llmClient = new LlmClient({
      baseUrl: config.ai.baseUrl,
      apiKey: config.ai.apiKey,
      model: configuredModel,
      timeoutMs: config.ai.timeoutMs,
      maxRetries: config.ai.maxRetries,
      simulateLlmFailure: config.demo.simulateLlmFailure,
      circuitBreaker: defaultCircuitBreaker,
    });

    const structuredService = new StructuredCompletionService(llmClient);

    let decisionResponse: DecisionResponse;

    // Helper to generate fallback and write transactional cost entry
    const runFallback = async (reason: string, errorMsg?: string): Promise<DecisionResponse> => {
      if (config.ai.enableRuleFallback === false) {
        throw new Error(errorMsg || `LLM decision failed and rule fallback is disabled (${reason})`);
      }
      recordFallback(reason);
      const fallbackDecision = generateFallbackDecision({
        riskType: recoveryCase.riskType as RiskType,
        riskBand: riskRecord?.band,
        priorRetriesCount: customerContext.recovery_history.prior_cases,
        overdueDays: customerContext.invoice_summary.overdue_count > 0 ? 7 : 0,
        amountAtRiskMinor: Number(recoveryCase.amountAtRisk),
        currency: recoveryCase.currency,
      });

      const persisted = await repos.withTransaction({ db }, async (tx) => {
        const dec = await repos.createDecision(
          { tx },
          {
            tenantId,
            caseId,
            model: configuredModel,
            promptVersion: prompt.version,
            inputSnapshot,
            outputRaw: fallbackDecision as unknown as Record<string, unknown>,
            diagnosisCause: fallbackDecision.diagnosis.cause,
            diagnosisConfidence: String(fallbackDecision.diagnosis.confidence),
            recommendedActions: fallbackDecision.actions,
            stopConditions: fallbackDecision.stop_conditions,
            status: "FALLBACK_RULE_BASED",
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            costMinorUnits: 0n,
            error: errorMsg,
          },
        );

        await repos.recordCostEntry(
          { tx },
          {
            tenantId,
            caseId,
            category: "LLM",
            amount: 0n,
            currency: recoveryCase.currency,
            metadata: {
              decision_id: dec.id,
              model: configuredModel,
              prompt_version: prompt.version,
              fallback: true,
              reason,
            },
            incurredAt: new Date(),
          },
        );

        return dec;
      });

      return {
        decisionId: persisted.id,
        caseId,
        status: "FALLBACK_RULE_BASED",
        diagnosis: fallbackDecision.diagnosis,
        actions: fallbackDecision.actions,
        stop_conditions: fallbackDecision.stop_conditions,
        latency_ms: 0,
        model: configuredModel,
        prompt_version: prompt.version,
        fallback: true,
      };
    };

    // 8. Execute LLM Pipeline with Fallback and Repair
    try {
      if (defaultCircuitBreaker.isOpen()) {
        logger.warn({ caseId }, "Circuit breaker is open; routing directly to rule-based fallback");
        decisionResponse = await runFallback("circuit_open", "Circuit breaker is OPEN");
      } else {
        let result: any;
        try {
          result = await structuredService.generateDecision({
            prompt,
            snapshot: inputSnapshot,
            model: configuredModel,
            customFetch,
          });
        } catch (llmErr: any) {
          logger.warn(
            { err: llmErr.message, caseId },
            "LLM inference call failed; degrading to rule-based fallback",
          );
          recordLlmCall(configuredModel, "error", 0);
          decisionResponse = await runFallback("transport_failure", llmErr.message);
          return await AiDecideService.finalizeIdempotency(
            { db, repos, compositeKey, response: decisionResponse },
          );
        }

        // Validate Structural
        const structResult = validateStructural(result.parsedJson);
        let validDecision: DecisionRecord | null = null;

        if (structResult.valid && structResult.data) {
          const semResult = validateSemantic(
            structResult.data,
            recoveryCase.riskType as RiskType,
          );
          if (semResult.valid) {
            validDecision = structResult.data;
          }
        }

        // If initial validation failed, attempt N=1 Repair Retry
        if (!validDecision) {
          logger.info(
            { caseId },
            "Initial LLM output failed validation; attempting N=1 repair retry",
          );
          const initialErrors = (structResult.errors || []).join(", ") || "Semantic validation failed";

          try {
            const repairResult = await structuredService.repairDecision({
              prompt,
              snapshot: inputSnapshot,
              previousOutput: result.rawText,
              validationErrors: initialErrors,
              model: configuredModel,
              customFetch,
            });

            const repStruct = validateStructural(repairResult.parsedJson);
            if (repStruct.valid && repStruct.data) {
              const repSem = validateSemantic(
                repStruct.data,
                recoveryCase.riskType as RiskType,
              );
              if (repSem.valid) {
                validDecision = repStruct.data;
                result = repairResult; // update metrics
              }
            }
          } catch (repairErr: any) {
            logger.warn({ err: repairErr.message }, "Repair retry call failed");
          }
        }

        if (validDecision) {
          // Persist COMPLETED decision row and Cost Ledger Entry in-tx (Step 15 §1)
          const persisted = await repos.withTransaction({ db }, async (tx) => {
            const dec = await repos.createDecision(
              { tx },
              {
                tenantId,
                caseId,
                model: result.model,
                promptVersion: prompt.version,
                inputSnapshot,
                outputRaw: result.parsedJson as Record<string, unknown>,
                diagnosisCause: validDecision.diagnosis.cause,
                diagnosisConfidence: String(validDecision.diagnosis.confidence),
                recommendedActions: validDecision.actions,
                stopConditions: validDecision.stop_conditions,
                status: "COMPLETED",
                latencyMs: result.latencyMs,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                costMinorUnits: result.costMinorUnits,
              },
            );

            await repos.recordCostEntry(
              { tx },
              {
                tenantId,
                caseId,
                category: "LLM",
                amount: result.costMinorUnits,
                currency: recoveryCase.currency,
                metadata: {
                  decision_id: dec.id,
                  model: result.model,
                  prompt_version: prompt.version,
                  input_tokens: result.inputTokens,
                  output_tokens: result.outputTokens,
                },
                incurredAt: new Date(),
              },
            );

            return dec;
          });

          recordLlmCall(result.model, "success", result.latencyMs, {
            prompt: result.inputTokens,
            completion: result.outputTokens,
            total: result.inputTokens + result.outputTokens,
          });

          decisionResponse = {
            decisionId: persisted.id,
            caseId,
            status: "COMPLETED",
            diagnosis: validDecision.diagnosis,
            actions: validDecision.actions,
            stop_conditions: validDecision.stop_conditions,
            latency_ms: result.latencyMs,
            model: result.model,
            prompt_version: prompt.version,
          };
        } else {
          // Persist INVALID_OUTPUT and cost entry in-tx, then trigger fallback
          await repos.withTransaction({ db }, async (tx) => {
            const dec = await repos.createDecision(
              { tx },
              {
                tenantId,
                caseId,
                model: result.model,
                promptVersion: prompt.version,
                inputSnapshot,
                outputRaw: (result.parsedJson as Record<string, unknown>) ?? {},
                status: "INVALID_OUTPUT",
                recommendedActions: [],
                stopConditions: [],
                latencyMs: result.latencyMs,
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                costMinorUnits: result.costMinorUnits,
                error: "Malformed structured output after repair retry",
              },
            );

            await repos.recordCostEntry(
              { tx },
              {
                tenantId,
                caseId,
                category: "LLM",
                amount: result.costMinorUnits,
                currency: recoveryCase.currency,
                metadata: {
                  decision_id: dec.id,
                  model: result.model,
                  prompt_version: prompt.version,
                  status: "INVALID_OUTPUT",
                  input_tokens: result.inputTokens,
                  output_tokens: result.outputTokens,
                },
                incurredAt: new Date(),
              },
            );

            return dec;
          });

          decisionResponse = await runFallback(
            "validation_failure",
            "Malformed output after repair retry",
          );
        }
      }
    } catch (unexpectedErr: any) {
      if (unexpectedErr instanceof ContextInvalidError || unexpectedErr instanceof ConfigurationError) {
        throw unexpectedErr;
      }
      logger.error(
        { err: unexpectedErr.message, caseId },
        "Unexpected error in AI decide service; applying safety fallback",
      );
      decisionResponse = await runFallback("unexpected_error", unexpectedErr.message);
    }

    return await AiDecideService.finalizeIdempotency({
      db,
      repos,
      compositeKey,
      response: decisionResponse,
    });
  }

  private static async finalizeIdempotency(opts: {
    db: Database;
    repos: Repositories;
    compositeKey?: string;
    response: DecisionResponse;
  }): Promise<DecisionResponse> {
    const { db, repos, compositeKey, response } = opts;
    if (compositeKey) {
      await repos.complete(
        { db },
        {
          key: compositeKey,
          responseSnapshot: response as unknown as Record<string, unknown>,
        },
      );
    }
    return response;
  }
}
