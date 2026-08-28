import type { Repositories } from "../../../plugins/db";
import type { Database } from "@repo/db";

export interface RiskMixQueryOptions {
  db: Database;
  repos: Repositories;
  tenantId: string;
  from?: Date;
  to?: Date;
}

export interface RiskMixItemResponse {
  risk_type: string;
  risk_band: string;
  count: number;
  amount_at_risk_minor: string;
}

export interface RiskMixResponsePayload {
  items: RiskMixItemResponse[];
}

export async function executeRiskMixQuery(
  opts: RiskMixQueryOptions,
): Promise<RiskMixResponsePayload> {
  const { db, repos, tenantId, from, to } = opts;

  const result = await repos.getRiskMix(
    { db },
    { tenantId, from, to },
  );

  return {
    items: result.items.map((item) => ({
      risk_type: item.risk_type,
      risk_band: item.risk_band,
      count: item.count,
      amount_at_risk_minor: item.amount_at_risk_minor.toString(),
    })),
  };
}
