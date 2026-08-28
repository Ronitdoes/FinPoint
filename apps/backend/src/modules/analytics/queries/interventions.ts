import type { Repositories } from "../../../plugins/db";
import type { Database } from "@repo/db";

export interface InterventionsQueryOptions {
  db: Database;
  repos: Repositories;
  tenantId: string;
  from?: Date;
  to?: Date;
}

export interface InterventionPerformanceItemResponse {
  type: string;
  cases: number;
  successes: number;
  recovered_minor: string;
  success_rate_bps: number;
}

export interface InterventionsResponsePayload {
  items: InterventionPerformanceItemResponse[];
}

export async function executeInterventionsQuery(
  opts: InterventionsQueryOptions,
): Promise<InterventionsResponsePayload> {
  const { db, repos, tenantId, from, to } = opts;

  const result = await repos.getInterventionPerformance(
    { db },
    { tenantId, from, to },
  );

  return {
    items: result.items.map((item) => ({
      type: item.type,
      cases: item.cases,
      successes: item.successes,
      recovered_minor: item.recovered_minor.toString(),
      success_rate_bps: item.success_rate_bps,
    })),
  };
}
