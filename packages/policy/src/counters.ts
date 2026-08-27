import type { CountersSnapshot } from "./types";

export interface CounterFetcherParams {
  tenantId: string;
  customerId?: string;
  caseId?: string;
}

export interface CounterFetcher {
  getCounters(params: CounterFetcherParams): Promise<CountersSnapshot>;
}
