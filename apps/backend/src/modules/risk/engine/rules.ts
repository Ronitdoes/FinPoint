import type { RiskBand } from "@repo/domain";
import type { Customer, Subscription, Payment } from "@repo/db";
import type { RiskFactor, RiskScoringConfig } from "../risk.types";

export const DEFAULT_AMOUNT_HIGH_MINOR_UNITS = 5_000_000n; // ₹50,000 in paise / minor units
export const DEFAULT_CHECKOUT_INTENT_MINOR_UNITS = 500_000n; // ₹5,000 in paise / minor units
export const DEFAULT_OVERDUE_DAYS = 3;
export const DEFAULT_HISTORY_WINDOW_DAYS = 180;
export const DEFAULT_SUCCESS_COUNT_THRESHOLD = 3;

export const DEFAULT_RISK_SCORING_CONFIG: Required<RiskScoringConfig> = {
  weights: {
    payment_failed_1: 20,
    payment_failed_2: 20,
    days_overdue_3: 15,
    amount_high: 10,
    customer_active: 10,
    historical_payment_success: 10,
    high_checkout_intent: 15,
  },
  thresholds: {
    amount_high_minor_units: DEFAULT_AMOUNT_HIGH_MINOR_UNITS,
    checkout_intent_minor_units: DEFAULT_CHECKOUT_INTENT_MINOR_UNITS,
    overdue_days: DEFAULT_OVERDUE_DAYS,
    history_window_days: DEFAULT_HISTORY_WINDOW_DAYS,
    success_count_threshold: DEFAULT_SUCCESS_COUNT_THRESHOLD,
  },
};

/**
 * Maps deterministic numeric score (0–100) to RiskBand.
 * LOW < 40 | MEDIUM 40–59 | HIGH 60–84 | CRITICAL ≥ 85
 */
export function calculateRiskBand(score: number): RiskBand {
  const boundedScore = Math.min(100, Math.max(0, score));
  if (boundedScore >= 85) return "CRITICAL";
  if (boundedScore >= 60) return "HIGH";
  if (boundedScore >= 40) return "MEDIUM";
  return "LOW";
}

/**
 * Rule: payment_failed_count >= 1 (+20) and payment_failed_count >= 2 (+20, cumulative +40)
 */
export function evaluatePaymentFailedCountRules(
  failedCount: number,
  config?: RiskScoringConfig,
): RiskFactor[] {
  const w1 = config?.weights?.payment_failed_1 ?? DEFAULT_RISK_SCORING_CONFIG.weights.payment_failed_1!;
  const w2 = config?.weights?.payment_failed_2 ?? DEFAULT_RISK_SCORING_CONFIG.weights.payment_failed_2!;

  const factor1: RiskFactor = {
    ruleId: "payment_failed_count_gte_1",
    points: failedCount >= 1 ? w1 : 0,
    detail: `Customer has ${failedCount} failed payment(s) (threshold >= 1)`,
    matched: failedCount >= 1,
  };

  const factor2: RiskFactor = {
    ruleId: "payment_failed_count_gte_2",
    points: failedCount >= 2 ? w2 : 0,
    detail: `Customer has ${failedCount} failed payment(s) (threshold >= 2)`,
    matched: failedCount >= 2,
  };

  return [factor1, factor2];
}

/**
 * Rule: days_overdue >= 3 (+15) (invoices)
 */
export function evaluateDaysOverdueRule(
  dueAt: Date,
  now: Date = new Date(),
  config?: RiskScoringConfig,
): RiskFactor {
  const thresholdDays = config?.thresholds?.overdue_days ?? DEFAULT_OVERDUE_DAYS;
  const weight = config?.weights?.days_overdue_3 ?? DEFAULT_RISK_SCORING_CONFIG.weights.days_overdue_3!;

  const diffMs = now.getTime() - dueAt.getTime();
  const daysOverdue = diffMs > 0 ? Math.floor(diffMs / (1000 * 60 * 60 * 24)) : 0;
  const matched = daysOverdue >= thresholdDays;

  return {
    ruleId: "days_overdue_gte_3",
    points: matched ? weight : 0,
    detail: `Invoice is ${daysOverdue} day(s) overdue (threshold >= ${thresholdDays})`,
    matched,
  };
}

/**
 * Rule: amount_high (+10) (amount >= ₹50,000 default)
 */
export function evaluateAmountHighRule(
  amount: bigint | number,
  config?: RiskScoringConfig,
): RiskFactor {
  const threshold = BigInt(
    config?.thresholds?.amount_high_minor_units ?? DEFAULT_AMOUNT_HIGH_MINOR_UNITS,
  );
  const weight = config?.weights?.amount_high ?? DEFAULT_RISK_SCORING_CONFIG.weights.amount_high!;
  const amountBig = BigInt(amount);
  const matched = amountBig >= threshold;

  return {
    ruleId: "amount_high",
    points: matched ? weight : 0,
    detail: `Subject amount (${amountBig.toString()} minor units) meets or exceeds high-value threshold (${threshold.toString()} minor units)`,
    matched,
  };
}

/**
 * Rule: customer_active (+10) (subscription ACTIVE or activity <= 90d)
 */
export function evaluateCustomerActiveRule(
  customer: Customer,
  subscriptions: Subscription[] = [],
  now: Date = new Date(),
  config?: RiskScoringConfig,
): RiskFactor {
  const weight = config?.weights?.customer_active ?? DEFAULT_RISK_SCORING_CONFIG.weights.customer_active!;

  const hasActiveSub = subscriptions.some(
    (sub) => sub.status === "ACTIVE",
  );

  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const customerLastActive = customer.updatedAt ?? customer.createdAt;
  const hasRecentActivity =
    now.getTime() - new Date(customerLastActive).getTime() <= ninetyDaysMs;

  const isActiveStatus = customer.status === "ACTIVE";

  const matched = hasActiveSub || hasRecentActivity || isActiveStatus;

  return {
    ruleId: "customer_active",
    points: matched ? weight : 0,
    detail: `Customer is active (active subscription: ${hasActiveSub}, recent activity <= 90d: ${hasRecentActivity}, status: ${customer.status})`,
    matched,
  };
}

/**
 * Rule: historical_payment_success (+10) (>= 3 succeeded payments)
 */
export function evaluateHistoricalPaymentSuccessRule(
  paymentsHistory: Payment[] = [],
  now: Date = new Date(),
  config?: RiskScoringConfig,
): RiskFactor {
  const weight =
    config?.weights?.historical_payment_success ??
    DEFAULT_RISK_SCORING_CONFIG.weights.historical_payment_success!;
  const windowDays =
    config?.thresholds?.history_window_days ?? DEFAULT_HISTORY_WINDOW_DAYS;
  const minSuccess =
    config?.thresholds?.success_count_threshold ?? DEFAULT_SUCCESS_COUNT_THRESHOLD;

  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const windowStart = new Date(now.getTime() - windowMs);

  const successCount = paymentsHistory.filter((p) => {
    const isSuccess = p.status === "SUCCEEDED";
    const paymentDate = p.paidAt ?? p.occurredAt ?? p.createdAt;
    const isWithinWindow = new Date(paymentDate) >= windowStart;
    return isSuccess && isWithinWindow;
  }).length;

  const matched = successCount >= minSuccess;

  return {
    ruleId: "historical_payment_success",
    points: matched ? weight : 0,
    detail: `Customer has ${successCount} successful payment(s) within ${windowDays}d window (threshold >= ${minSuccess})`,
    matched,
  };
}

/**
 * Rule: high_checkout_intent (+15) (payment_started or cart_value >= ₹5,000)
 */
export function evaluateHighCheckoutIntentRule(
  status: string,
  cartValue: bigint | number,
  config?: RiskScoringConfig,
): RiskFactor {
  const weight =
    config?.weights?.high_checkout_intent ??
    DEFAULT_RISK_SCORING_CONFIG.weights.high_checkout_intent!;
  const minCartValue = BigInt(
    config?.thresholds?.checkout_intent_minor_units ??
      DEFAULT_CHECKOUT_INTENT_MINOR_UNITS,
  );

  const isPaymentStarted =
    status === "PAYMENT_STARTED" ||
    status === "CHECKOUT_PAYMENT_STARTED" ||
    status === "payment_started";

  const cartValueBig = BigInt(cartValue);
  const isHighCart = cartValueBig >= minCartValue;

  const matched = isPaymentStarted || isHighCart;

  return {
    ruleId: "high_checkout_intent",
    points: matched ? weight : 0,
    detail: `Checkout intent evaluated (payment started: ${isPaymentStarted}, cart value: ${cartValueBig.toString()} >= ${minCartValue.toString()})`,
    matched,
  };
}
