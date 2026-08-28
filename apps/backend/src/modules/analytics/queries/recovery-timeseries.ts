import type { Repositories } from "../../../plugins/db";
import type { Database } from "@repo/db";

export interface RecoveryTimeseriesQueryOptions {
  db: Database;
  repos: Repositories;
  tenantId: string;
  from?: Date;
  to?: Date;
  bucket?: "day" | "week";
  isFinanceOrAdmin: boolean;
}

export interface RecoveryTimeseriesItemResponse {
  date: string;
  at_risk_minor: string;
  recovered_minor: string;
  recovery_cost_minor?: string;
  net_minor?: string;
}

export interface RecoveryTimeseriesResponsePayload {
  bucket: "day" | "week";
  timeseries: RecoveryTimeseriesItemResponse[];
}

export async function executeRecoveryTimeseriesQuery(
  opts: RecoveryTimeseriesQueryOptions,
): Promise<RecoveryTimeseriesResponsePayload> {
  const { db, repos, tenantId, from, to, bucket, isFinanceOrAdmin } = opts;

  const result = await repos.getRecoveryTimeseries(
    { db },
    { tenantId, from, to, bucket },
  );

  const timeseries: RecoveryTimeseriesItemResponse[] = result.timeseries.map((item) => {
    const responseItem: RecoveryTimeseriesItemResponse = {
      date: item.date,
      at_risk_minor: item.at_risk_minor.toString(),
      recovered_minor: item.recovered_minor.toString(),
    };

    // Cost-field role gating (FINANCE+)
    if (isFinanceOrAdmin) {
      responseItem.recovery_cost_minor = item.recovery_cost_minor.toString();
      responseItem.net_minor = item.net_minor.toString();
    }

    return responseItem;
  });

  return {
    bucket: result.bucket,
    timeseries,
  };
}
