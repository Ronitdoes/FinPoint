import {
  evaluateAmountHighRule,
  evaluateCustomerActiveRule,
  evaluateDaysOverdueRule,
  evaluateHistoricalPaymentSuccessRule,
  evaluatePaymentFailedCountRules,
  calculateRiskBand,
} from "./rules";
import type {
  RiskScoreResult,
  RiskScoringConfig,
  SubjectAggregates,
  RiskFactor,
} from "../risk.types";

/**
 * Scores invoice-overdue risk deterministically based on Spec 01 §8 weight table.
 */
export function scoreInvoice(
  aggregates: SubjectAggregates,
  config?: RiskScoringConfig,
): RiskScoreResult {
  const {
    customer,
    invoice,
    subscriptions = [],
    paymentsHistory = [],
    now = new Date(),
  } = aggregates;

  const factors: RiskFactor[] = [];

  // 1. Days overdue rule (+15 if overdue >= 3 days)
  if (invoice) {
    factors.push(evaluateDaysOverdueRule(invoice.dueAt, now, config));
    // 2. Amount high rule (+10 if invoice amount >= ₹50,000)
    factors.push(evaluateAmountHighRule(invoice.amount, config));
  }

  // 3. Prior payment failures for customer (+20 at >= 1, +20 at >= 2)
  const failedPaymentsCount = paymentsHistory.filter(
    (p) => p.status === "FAILED",
  ).length;
  factors.push(...evaluatePaymentFailedCountRules(failedPaymentsCount, config));

  // 4. Customer active rule (+10)
  factors.push(evaluateCustomerActiveRule(customer, subscriptions, now, config));

  // 5. Historical payment success rule (+10)
  factors.push(evaluateHistoricalPaymentSuccessRule(paymentsHistory, now, config));

  // Calculate total score capped at 100
  const rawScore = factors.reduce((sum, f) => sum + f.points, 0);
  const finalScore = Math.min(100, Math.max(0, rawScore));
  const band = calculateRiskBand(finalScore);

  const breakdown: Record<string, number> = {};
  for (const f of factors) {
    breakdown[f.ruleId] = f.points;
  }

  return {
    score: finalScore,
    band,
    riskType: "INVOICE_OVERDUE",
    factors: {
      rules: factors,
      baseScore: 0,
      totalScore: finalScore,
      band,
      evaluatedAt: now.toISOString(),
      breakdown,
    },
  };
}
