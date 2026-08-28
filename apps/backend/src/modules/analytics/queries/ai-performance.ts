import type { Repositories } from "../../../plugins/db";
import type { Database } from "@repo/db";

export interface AiPerformanceQueryOptions {
  db: Database;
  repos: Repositories;
  tenantId: string;
  from?: Date;
  to?: Date;
  isFinanceOrAdmin: boolean;
}

export interface AiPerformanceResponsePayload {
  decisions: number;
  decision_acceptance_rate_bps: number;
  recommendation_to_exec_rate_bps: number;
  policy_rejections: number;
  policy_rejection_rate_bps: number;
  approvals_required: number;
  avg_decision_ms: number;
  cost_per_case_minor?: string;
  cost_per_recovered_bps?: number;
  total_ai_cost_minor?: string;
}

export async function executeAiPerformanceQuery(
  opts: AiPerformanceQueryOptions,
): Promise<AiPerformanceResponsePayload> {
  const { db, repos, tenantId, from, to, isFinanceOrAdmin } = opts;

  const result = await repos.getAiPerformance(
    { db },
    { tenantId, from, to },
  );

  const payload: AiPerformanceResponsePayload = {
    decisions: result.decisions,
    decision_acceptance_rate_bps: result.decision_acceptance_rate_bps,
    recommendation_to_exec_rate_bps: result.recommendation_to_exec_rate_bps,
    policy_rejections: result.policy_rejections,
    policy_rejection_rate_bps: result.policy_rejection_rate_bps,
    approvals_required: result.approvals_required,
    avg_decision_ms: result.avg_decision_ms,
  };

  // Cost-field role gating (FINANCE+)
  if (isFinanceOrAdmin) {
    payload.cost_per_case_minor = result.cost_per_case_minor.toString();
    payload.cost_per_recovered_bps = result.cost_per_recovered_bps;
    payload.total_ai_cost_minor = result.total_ai_cost_minor.toString();
  }

  return payload;
}
