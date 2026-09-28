import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { fetchWithAnalyticsCache, buildAnalyticsCacheKey } from "./cache";

/**
 * s-27 single-flight stampede guard (LOW-RISK, no behavior change).
 *
 * fetchWithAnalyticsCache coalesces concurrent cold requests on the same
 * cache key via the module-level inFlightMap so a single compute serves all
 * waiters. Cache-hit/bust is already covered by the analytics integration
 * suite (src/tests/analytics-integration.test.ts §9); this file proves the
 * concurrent path directly with redis=null (no live infra required).
 */
describe("s-27 analytics cache single-flight", () => {
  it("coalesces two parallel cold requests into a single compute", async () => {
    const tenantId = `tenant_${randomUUID()}`;
    const endpoint = "summary";
    const params = { from: "2026-08-01", to: "2026-08-31" };

    let computeCount = 0;
    const fetcher = async () => {
      computeCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { value: "computed-once" };
    };

    const [first, second] = await Promise.all([
      fetchWithAnalyticsCache(null, tenantId, endpoint, params, fetcher),
      fetchWithAnalyticsCache(null, tenantId, endpoint, params, fetcher),
    ]);

    expect(first).toEqual({ value: "computed-once" });
    expect(second).toEqual({ value: "computed-once" });
    expect(computeCount).toBe(1);
  });

  it("computes separately for distinct param sets (key isolation)", async () => {
    const tenantId = `tenant_${randomUUID()}`;
    let computeCount = 0;
    const makeFetcher = (tag: string) => async () => {
      computeCount += 1;
      return { tag };
    };

    const [a, b] = await Promise.all([
      fetchWithAnalyticsCache(null, tenantId, "summary", { bucket: "day" }, makeFetcher("a")),
      fetchWithAnalyticsCache(null, tenantId, "summary", { bucket: "week" }, makeFetcher("b")),
    ]);

    expect(a).toEqual({ tag: "a" });
    expect(b).toEqual({ tag: "b" });
    expect(computeCount).toBe(2);
  });

  it("coalesces N concurrent cold calls into a single underlying fetch", async () => {
    const tenantId = `tenant_${randomUUID()}`;
    const endpoint = "ai";
    const params = { from: "2026-08-01", to: "2026-08-31", bucket: "day" };

    let computeCount = 0;
    const fetcher = async () => {
      computeCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { value: "computed-once-n" };
    };

    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        fetchWithAnalyticsCache(null, tenantId, endpoint, params, fetcher),
      ),
    );

    for (const r of results) {
      expect(r).toEqual({ value: "computed-once-n" });
    }
    expect(computeCount).toBe(1);
  });

  it("builds deterministic keys regardless of param order", () => {
    const tenantId = "tenant_key_order";
    const k1 = buildAnalyticsCacheKey(tenantId, "summary", { a: 1, b: 2 });
    const k2 = buildAnalyticsCacheKey(tenantId, "summary", { b: 2, a: 1 });
    expect(k1).toBe(k2);
  });
});
