import type { Repositories } from "../../../plugins/db";
import type { Database } from "@repo/db";

export interface SummaryQueryOptions {
  db: Database;
  repos: Repositories;
  tenantId: string;
  from?: Date;
  to?: Date;
  isFinanceOrAdmin: boolean;
}

export interface SummaryResponsePayload {
  financial: {
    revenue_at_risk_minor: string;
    revenue_recovered_minor: string;
    recovery_rate_bps: number;
    recovery_cost_minor?: string;
    net_recovered_minor?: string;
    recovery_roi_bps?: number | null;
    currency: string;
  };
  operational: {
    active_cases: number;
    escalations: number;
    avg_time_to_recovery_seconds: number;
  };
}

export async function executeSummaryQuery(
  opts: SummaryQueryOptions,
): Promise<SummaryResponsePayload> {
  const { db, repos, tenantId, from, to, isFinanceOrAdmin } = opts;

  const result = await repos.getAnalyticsSummary(
    { db },
    { tenantId, from, to },
  );

  const payload: SummaryResponsePayload = {
    financial: {
      revenue_at_risk_minor: result.revenue_at_risk_minor.toString(),
      revenue_recovered_minor: result.revenue_recovered_minor.toString(),
      recovery_rate_bps: result.recovery_rate_bps,
      currency: result.currency,
    },
    operational: {
      active_cases: result.active_cases,
      escalations: result.escalations,
      avg_time_to_recovery_seconds: result.avg_time_to_recovery_seconds,
    },
  };

  // Cost-field role gating (FINANCE+)
  if (isFinanceOrAdmin) {
    payload.financial.recovery_cost_minor = result.recovery_cost_minor.toString();
    payload.financial.net_recovered_minor = result.net_recovered_minor.toString();
    payload.financial.recovery_roi_bps = result.recovery_roi_bps;
  }

  return payload;
}
