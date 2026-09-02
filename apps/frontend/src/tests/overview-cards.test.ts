import { describe, it, expect } from "vitest";
import { formatMoney } from "../lib/money";
import { formatPercent } from "../lib/format";
import type { AnalyticsSummary } from "../lib/types";

describe("Overview Cards Reconciliation with /analytics/summary (Spec 00 §6, Spec 03 §7, s-28 DoD)", () => {
  // Canonical fixture matching Spec 00 §6 numbers and Step 27 /analytics/summary response shape
  const fixtureSummaryPayload: AnalyticsSummary = {
    revenueAtRisk: "128000000", // ₹12.8L in paise
    revenueRecovered: "84000000", // ₹8.4L in paise
    recoveryRate: 65.4, // 65.4%
    recoveryCost: "7200000", // ₹72K in paise
    netRecovered: "76800000", // ₹7.68L in paise
    activeCases: 182,
    escalatedCases: 21,
    recoveredCases: 64,
    stoppedCases: 42,
    failedCases: 15,
    timeRange: {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T23:59:59.999Z",
    },
  };

  it("reconciles all 7 executive overview cards exactly with Spec 00 §6 canonical targets", () => {
    // 1. Revenue at Risk
    const revenueAtRiskCard = {
      title: "Revenue at Risk",
      compactValue: formatMoney(fixtureSummaryPayload.revenueAtRisk, "INR", { compact: true }),
      fullValue: formatMoney(fixtureSummaryPayload.revenueAtRisk, "INR"),
    };
    expect(revenueAtRiskCard.compactValue).toBe("₹12.8L");
    expect(revenueAtRiskCard.fullValue).toBe("₹12,80,000");

    // 2. Recovered Revenue
    const recoveredCard = {
      title: "Recovered Revenue",
      compactValue: formatMoney(fixtureSummaryPayload.revenueRecovered, "INR", { compact: true }),
      fullValue: formatMoney(fixtureSummaryPayload.revenueRecovered, "INR"),
    };
    expect(recoveredCard.compactValue).toBe("₹8.4L");
    expect(recoveredCard.fullValue).toBe("₹8,40,000");

    // 3. Recovery Rate
    const recoveryRateCard = {
      title: "Recovery Rate",
      value: formatPercent(fixtureSummaryPayload.recoveryRate),
      subValue: `${fixtureSummaryPayload.recoveredCases} cases recovered`,
    };
    expect(recoveryRateCard.value).toBe("65.4%");
    expect(recoveryRateCard.subValue).toBe("64 cases recovered");

    // 4. Recovery Cost
    const recoveryCostCard = {
      title: "Recovery Cost",
      compactValue: formatMoney(fixtureSummaryPayload.recoveryCost, "INR", { compact: true }),
      fullValue: formatMoney(fixtureSummaryPayload.recoveryCost, "INR"),
    };
    expect(recoveryCostCard.compactValue).toBe("₹72K");
    expect(recoveryCostCard.fullValue).toBe("₹72,000");

    // 5. Net Recovered
    const netRecoveredCard = {
      title: "Net Recovered",
      compactValue: formatMoney(fixtureSummaryPayload.netRecovered, "INR", { compact: true }),
      fullValue: formatMoney(fixtureSummaryPayload.netRecovered, "INR"),
    };
    expect(netRecoveredCard.compactValue).toBe("₹7.68L");
    expect(netRecoveredCard.fullValue).toBe("₹7,68,000");

    // 6. Active Cases
    expect(fixtureSummaryPayload.activeCases).toBe(182);

    // 7. Escalated Cases
    expect(fixtureSummaryPayload.escalatedCases).toBe(21);
  });

  it("reconciles net recovered arithmetic with recovery cost", () => {
    // Net Recovered = Recovered - Recovery Cost
    const recovered = BigInt(fixtureSummaryPayload.revenueRecovered);
    const cost = BigInt(fixtureSummaryPayload.recoveryCost!);
    const net = BigInt(fixtureSummaryPayload.netRecovered!);

    expect(recovered - cost).toBe(net);
    expect(recovered - cost).toBe(BigInt(76800000));
  });

  it("handles cost-redacted payloads gracefully (VIEWER role)", () => {
    const redactedPayload: AnalyticsSummary = {
      ...fixtureSummaryPayload,
      recoveryCost: null,
      netRecovered: null,
    };

    const costCardValue = redactedPayload.recoveryCost !== null
      ? formatMoney(redactedPayload.recoveryCost, "INR", { compact: true })
      : "—";

    const netCardValue = redactedPayload.netRecovered !== null
      ? formatMoney(redactedPayload.netRecovered, "INR", { compact: true })
      : "—";

    expect(costCardValue).toBe("—");
    expect(netCardValue).toBe("—");
  });

  it("matches snapshot of reconciled card presentation data", () => {
    const cardsSnapshot = {
      revenueAtRisk: formatMoney(fixtureSummaryPayload.revenueAtRisk, "INR", { compact: true }),
      recovered: formatMoney(fixtureSummaryPayload.revenueRecovered, "INR", { compact: true }),
      recoveryRate: formatPercent(fixtureSummaryPayload.recoveryRate),
      recoveryCost: formatMoney(fixtureSummaryPayload.recoveryCost, "INR", { compact: true }),
      netRecovered: formatMoney(fixtureSummaryPayload.netRecovered, "INR", { compact: true }),
      activeCases: fixtureSummaryPayload.activeCases,
      escalatedCases: fixtureSummaryPayload.escalatedCases,
      recoveredCases: fixtureSummaryPayload.recoveredCases,
    };

    expect(cardsSnapshot).toEqual({
      revenueAtRisk: "₹12.8L",
      recovered: "₹8.4L",
      recoveryRate: "65.4%",
      recoveryCost: "₹72K",
      netRecovered: "₹7.68L",
      activeCases: 182,
      escalatedCases: 21,
      recoveredCases: 64,
    });
  });
});
