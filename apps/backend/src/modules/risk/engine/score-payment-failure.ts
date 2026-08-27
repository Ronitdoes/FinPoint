import {
  evaluateAmountHighRule,
  evaluateCustomerActiveRule,
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
 * Scores payment-failure risk deterministically based on Spec 01 §8 weight table.
 */
export function scorePaymentFailure(
  aggregates: SubjectAggregates,
  config?: RiskScoringConfig,
): RiskScoreResult {
  const { customer, payment, subscriptions = [], paymentsHistory = [], paymentAttempts = [], now = new Date() } = aggregates;

  // Calculate failed payment count for this customer (or attempts for this payment)
  const failedPaymentsFromHistory = paymentsHistory.filter(
    (p) => p.status === "FAILED",
  ).length;

  const failedAttemptsForThisPayment = paymentAttempts.filter(
    (a) => a.status === "FAILED",
  ).length;

  // Total failures observed (at least 1 since this is triggered by payment.failed)
  const failedCount = Math.max(1, failedPaymentsFromHistory, failedAttemptsForThisPayment);

  const factors: RiskFactor[] = [];

  // 1. Payment failed count rules (+20 at >= 1, +20 at >= 2)
  const failFactors = evaluatePaymentFailedCountRules(failedCount, config);
  factors.push(...failFactors);

  // 2. Amount high rule (+10)
  if (payment) {
    factors.push(evaluateAmountHighRule(payment.amount, config));
  }

  // 3. Customer active rule (+10)
  factors.push(evaluateCustomerActiveRule(customer, subscriptions, now, config));

  // 4. Historical payment success rule (+10)
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
    riskType: "PAYMENT_FAILURE",
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
