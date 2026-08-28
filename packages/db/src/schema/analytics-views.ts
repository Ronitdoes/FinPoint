import { pgSchema } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";
import { recoveryCases } from "./cases";
import { recoveryOutcomes } from "./outcomes";
import { recoveryActions } from "./actions";
import { revenueRisks } from "./risks";
import { aiDecisions } from "./decisions";
import { policyEvaluations } from "./policies";

/**
 * PostgreSQL analytics schema and materialized-friendly SQL views (Step 27, Spec 01 §25, Spec 02 §13).
 * Keeps heavy aggregation queries off hot OLTP paths with strict tenant isolation.
 */
export const analyticsSchema = pgSchema("analytics");

/**
 * v_recovery_summary — Authoritative overview combining recovery cases with recorded outcomes.
 */
export const vRecoverySummary = analyticsSchema.view("v_recovery_summary").as((qb) =>
  qb
    .select({
      case_id: sql`"recovery_cases"."id"`.as("case_id"),
      tenant_id: sql`"recovery_cases"."tenant_id"`.as("tenant_id"),
      case_number: sql`"recovery_cases"."case_number"`.as("case_number"),
      customer_id: sql`"recovery_cases"."customer_id"`.as("customer_id"),
      risk_type: sql`"recovery_cases"."risk_type"`.as("risk_type"),
      amount_at_risk: sql`"recovery_cases"."amount_at_risk"`.as("amount_at_risk"),
      currency: sql`"recovery_cases"."currency"`.as("currency"),
      status: sql`"recovery_cases"."status"`.as("status"),
      opened_at: sql`"recovery_cases"."opened_at"`.as("opened_at"),
      closed_at: sql`"recovery_cases"."closed_at"`.as("closed_at"),
      outcome_id: sql`"recovery_outcomes"."id"`.as("outcome_id"),
      payment_id: sql`"recovery_outcomes"."payment_id"`.as("payment_id"),
      recovered_amount: sql`"recovery_outcomes"."recovered_amount"`.as("recovered_amount"),
      recovery_cost: sql`"recovery_outcomes"."recovery_cost"`.as("recovery_cost"),
      net_recovered: sql`"recovery_outcomes"."net_recovered"`.as("net_recovered"),
      attribution_method: sql`"recovery_outcomes"."attribution_method"`.as("attribution_method"),
      attribution_window_hours: sql`"recovery_outcomes"."attribution_window_hours"`.as("attribution_window_hours"),
      recovered_at: sql`"recovery_outcomes"."recovered_at"`.as("recovered_at"),
      recorded_at: sql`"recovery_outcomes"."recorded_at"`.as("recorded_at"),
    })
    .from(recoveryCases)
    .leftJoin(
      recoveryOutcomes,
      eq(recoveryCases.id, recoveryOutcomes.caseId),
    ),
);

/**
 * v_recovery_timeseries — Recovery time-series projection across authoritative outcomes.
 */
export const vRecoveryTimeseries = analyticsSchema.view("v_recovery_timeseries").as((qb) =>
  qb
    .select({
      outcome_id: sql`"recovery_outcomes"."id"`.as("outcome_id"),
      tenant_id: sql`"recovery_outcomes"."tenant_id"`.as("tenant_id"),
      case_id: sql`"recovery_outcomes"."case_id"`.as("case_id"),
      payment_id: sql`"recovery_outcomes"."payment_id"`.as("payment_id"),
      baseline_amount: sql`"recovery_outcomes"."baseline_amount"`.as("baseline_amount"),
      recovered_amount: sql`"recovery_outcomes"."recovered_amount"`.as("recovered_amount"),
      recovery_cost: sql`"recovery_outcomes"."recovery_cost"`.as("recovery_cost"),
      net_recovered: sql`"recovery_outcomes"."net_recovered"`.as("net_recovered"),
      attribution_method: sql`"recovery_outcomes"."attribution_method"`.as("attribution_method"),
      attribution_window_hours: sql`"recovery_outcomes"."attribution_window_hours"`.as("attribution_window_hours"),
      recovered_at: sql`"recovery_outcomes"."recovered_at"`.as("recovered_at"),
      recorded_at: sql`"recovery_outcomes"."recorded_at"`.as("recorded_at"),
    })
    .from(recoveryOutcomes),
);

/**
 * v_intervention_performance — Performance by action type joining executed actions, cases, and outcomes.
 */
export const vInterventionPerformance = analyticsSchema
  .view("v_intervention_performance")
  .as((qb) =>
    qb
      .select({
        action_id: sql`"recovery_actions"."id"`.as("action_id"),
        tenant_id: sql`"recovery_actions"."tenant_id"`.as("tenant_id"),
        action_type: sql`"recovery_actions"."type"`.as("action_type"),
        case_id: sql`"recovery_actions"."case_id"`.as("case_id"),
        risk_type: sql`"recovery_cases"."risk_type"`.as("risk_type"),
        amount_at_risk: sql`"recovery_cases"."amount_at_risk"`.as("amount_at_risk"),
        action_status: sql`"recovery_actions"."status"`.as("action_status"),
        action_completed_at: sql`"recovery_actions"."completed_at"`.as("action_completed_at"),
        action_created_at: sql`"recovery_actions"."created_at"`.as("action_created_at"),
        outcome_id: sql`"recovery_outcomes"."id"`.as("outcome_id"),
        recovered_amount: sql`"recovery_outcomes"."recovered_amount"`.as("recovered_amount"),
        recovery_cost: sql`"recovery_outcomes"."recovery_cost"`.as("recovery_cost"),
        net_recovered: sql`"recovery_outcomes"."net_recovered"`.as("net_recovered"),
        recovered_at: sql`"recovery_outcomes"."recovered_at"`.as("recovered_at"),
      })
      .from(recoveryActions)
      .innerJoin(recoveryCases, eq(recoveryActions.caseId, recoveryCases.id))
      .leftJoin(
        recoveryOutcomes,
        eq(recoveryCases.id, recoveryOutcomes.caseId),
      ),
  );

/**
 * v_funnel — 5-stage recovery funnel progression per case.
 */
export const vFunnel = analyticsSchema.view("v_funnel").as((qb) =>
  qb
    .select({
      case_id: sql`"recovery_cases"."id"`.as("case_id"),
      tenant_id: sql`"recovery_cases"."tenant_id"`.as("tenant_id"),
      customer_id: sql`"recovery_cases"."customer_id"`.as("customer_id"),
      risk_type: sql`"recovery_cases"."risk_type"`.as("risk_type"),
      amount_at_risk: sql`"recovery_cases"."amount_at_risk"`.as("amount_at_risk"),
      currency: sql`"recovery_cases"."currency"`.as("currency"),
      status: sql`"recovery_cases"."status"`.as("status"),
      opened_at: sql`"recovery_cases"."opened_at"`.as("opened_at"),
      outcome_id: sql`"recovery_outcomes"."id"`.as("outcome_id"),
      recovered_amount: sql`"recovery_outcomes"."recovered_amount"`.as("recovered_amount"),
      recovered_at: sql`"recovery_outcomes"."recovered_at"`.as("recovered_at"),
    })
    .from(recoveryCases)
    .leftJoin(
      recoveryOutcomes,
      eq(recoveryCases.id, recoveryOutcomes.caseId),
    ),
);

/**
 * v_risk_mix — Case breakdown across risk types and risk bands.
 */
export const vRiskMix = analyticsSchema.view("v_risk_mix").as((qb) =>
  qb
    .select({
      case_id: sql`"recovery_cases"."id"`.as("case_id"),
      tenant_id: sql`"recovery_cases"."tenant_id"`.as("tenant_id"),
      risk_type: sql`"recovery_cases"."risk_type"`.as("risk_type"),
      risk_band: sql`COALESCE("revenue_risks"."band"::text, CASE WHEN "recovery_cases"."risk_score" >= 70 THEN 'HIGH' WHEN "recovery_cases"."risk_score" >= 40 THEN 'MEDIUM' ELSE 'LOW' END)`.as("risk_band"),
      risk_score: sql`"recovery_cases"."risk_score"`.as("risk_score"),
      amount_at_risk: sql`"recovery_cases"."amount_at_risk"`.as("amount_at_risk"),
      currency: sql`"recovery_cases"."currency"`.as("currency"),
      status: sql`"recovery_cases"."status"`.as("status"),
      opened_at: sql`"recovery_cases"."opened_at"`.as("opened_at"),
      outcome_id: sql`"recovery_outcomes"."id"`.as("outcome_id"),
      recovered_amount: sql`"recovery_outcomes"."recovered_amount"`.as("recovered_amount"),
    })
    .from(recoveryCases)
    .leftJoin(revenueRisks, eq(recoveryCases.riskId, revenueRisks.id))
    .leftJoin(
      recoveryOutcomes,
      eq(recoveryCases.id, recoveryOutcomes.caseId),
    ),
);

/**
 * v_ai_performance — AI decisioning metrics, latency, token costs, and policy evaluation results.
 */
export const vAiPerformance = analyticsSchema.view("v_ai_performance").as((qb) =>
  qb
    .select({
      decision_id: sql`"ai_decisions"."id"`.as("decision_id"),
      tenant_id: sql`"ai_decisions"."tenant_id"`.as("tenant_id"),
      case_id: sql`"ai_decisions"."case_id"`.as("case_id"),
      model: sql`"ai_decisions"."model"`.as("model"),
      decision_status: sql`"ai_decisions"."status"`.as("decision_status"),
      latency_ms: sql`"ai_decisions"."latency_ms"`.as("latency_ms"),
      input_tokens: sql`"ai_decisions"."input_tokens"`.as("input_tokens"),
      output_tokens: sql`"ai_decisions"."output_tokens"`.as("output_tokens"),
      llm_cost_minor: sql`"ai_decisions"."cost_minor_units"`.as("llm_cost_minor"),
      evaluation_id: sql`"policy_evaluations"."id"`.as("evaluation_id"),
      policy_result: sql`"policy_evaluations"."result"`.as("policy_result"),
      policy_latency_ms: sql`"policy_evaluations"."latency_ms"`.as("policy_latency_ms"),
      decision_created_at: sql`"ai_decisions"."created_at"`.as("decision_created_at"),
    })
    .from(aiDecisions)
    .leftJoin(policyEvaluations, eq(aiDecisions.id, policyEvaluations.decisionId)),
);
