import {
  evaluateAmountHighRule,
  evaluateCustomerActiveRule,
  evaluateHighCheckoutIntentRule,
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
 * Scores checkout-abandonment risk deterministically based on Spec 01 §8 weight table.
 */
export function scoreCheckout(
  aggregates: SubjectAggregates,
  config?: RiskScoringConfig,
): RiskScoreResult {
  const {
    customer,
    checkout,
    subscriptions = [],
    paymentsHistory = [],
    checkoutEvents = [],
    now = new Date(),
  } = aggregates;

  const factors: RiskFactor[] = [];

  const cartValue = checkout?.cartValue ?? 0n;

  // Determine if checkout had payment started
  const isPaymentStartedInEvents = checkoutEvents.some(
    (e) => e.type === "PAYMENT_STARTED" || e.type === "checkout.payment_started",
  );
  const checkoutStatus = checkout?.status ?? "ABANDONED";
  const effectiveStatus = isPaymentStartedInEvents ? "PAYMENT_STARTED" : checkoutStatus;

  // 1. High checkout intent rule (+15) (payment_started or cart_value >= ₹5,000)
  factors.push(evaluateHighCheckoutIntentRule(effectiveStatus, cartValue, config));

  // 2. Amount high rule (+10) (cart_value >= ₹50,000)
  factors.push(evaluateAmountHighRule(cartValue, config));

  // 3. Customer active rule (+10)
  factors.push(evaluateCustomerActiveRule(customer, subscriptions, now, config));

  // 4. Historical payment success rule (+10)
  factors.push(evaluateHistoricalPaymentSuccessRule(paymentsHistory, now, config));

  // 5. Prior payment failure count rules (+20 / +20 if customer experienced failures before)
  const failedPaymentsCount = paymentsHistory.filter(
    (p) => p.status === "FAILED",
  ).length;
  factors.push(...evaluatePaymentFailedCountRules(failedPaymentsCount, config));

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
    riskType: "CHECKOUT_ABANDONMENT",
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
