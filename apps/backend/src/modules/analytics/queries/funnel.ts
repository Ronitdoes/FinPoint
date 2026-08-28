import type { Repositories } from "../../../plugins/db";
import type { Database } from "@repo/db";

export interface FunnelQueryOptions {
  db: Database;
  repos: Repositories;
  tenantId: string;
  from?: Date;
  to?: Date;
}

export interface FunnelStageItemResponse {
  stage: "AT_RISK" | "QUALIFIED" | "CONTACTED" | "ATTEMPTED" | "RECOVERED";
  count: number;
  amount_minor: string;
}

export interface FunnelResponsePayload {
  stages: FunnelStageItemResponse[];
  conversion_rate_bps: number;
}

export async function executeFunnelQuery(
  opts: FunnelQueryOptions,
): Promise<FunnelResponsePayload> {
  const { db, repos, tenantId, from, to } = opts;

  const result = await repos.getRecoveryFunnel(
    { db },
    { tenantId, from, to },
  );

  return {
    stages: result.stages.map((s) => ({
      stage: s.stage,
      count: s.count,
      amount_minor: s.amount_minor.toString(),
    })),
    conversion_rate_bps: result.conversion_rate_bps,
  };
}
