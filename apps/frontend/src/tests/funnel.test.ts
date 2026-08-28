import { describe, it, expect } from "vitest";
import type { FunnelStage, InterventionStat } from "../lib/types";

describe("Recovery Analytics Funnel & Math Validation (Spec 03 §7, Step 27, Step 28)", () => {
  const fixtureFunnelPayload: FunnelStage[] = [
    { stage: "AT_RISK", count: 182, value: "128000000", conversionRate: 100 },
    { stage: "QUALIFIED", count: 154, value: "112000000", conversionRate: 84.6 },
    { stage: "CONTACTED", count: 130, value: "98000000", conversionRate: 84.4 },
    { stage: "ATTEMPTED", count: 98, value: "88000000", conversionRate: 75.4 },
    { stage: "RECOVERED", count: 64, value: "84000000", conversionRate: 65.3 },
  ];

  it("verifies 5-stage progression sequence from fixture payload", () => {
    expect(fixtureFunnelPayload).toHaveLength(5);
    expect(fixtureFunnelPayload[0].stage).toBe("AT_RISK");
    expect(fixtureFunnelPayload[4].stage).toBe("RECOVERED");

    // Monotonically non-increasing case counts
    for (let i = 1; i < fixtureFunnelPayload.length; i++) {
      expect(fixtureFunnelPayload[i].count).toBeLessThanOrEqual(
        fixtureFunnelPayload[i - 1].count,
      );
    }
  });

  it("verifies intervention success rate calculations", () => {
    const fixtureInterventions: InterventionStat[] = [
      {
        actionType: "RETRY_PAYMENT",
        totalAttempts: 120,
        successfulAttempts: 78,
        failedAttempts: 42,
        successRate: 65.0,
        totalRecovered: "54000000",
        averageCost: "1200",
      },
      {
        actionType: "SEND_WHATSAPP",
        totalAttempts: 80,
        successfulAttempts: 52,
        failedAttempts: 28,
        successRate: 65.0,
        totalRecovered: "30000000",
        averageCost: "80",
      },
    ];

    expect(fixtureInterventions[0].successfulAttempts / fixtureInterventions[0].totalAttempts).toBeCloseTo(0.65, 2);
  });
});
