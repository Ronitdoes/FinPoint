import type {
  RiskBand,
  RiskType,
  RiskStatus,
} from "@repo/domain";
import type {
  Customer,
  Payment,
  Invoice,
  Checkout,
  Subscription,
  PaymentAttempt,
  CheckoutEvent,
} from "@repo/db";

export interface RiskFactor {
  ruleId: string;
  points: number;
  detail: string;
  matched: boolean;
}

export interface RiskFactorsBreakdown {
  rules: RiskFactor[];
  baseScore: number;
  totalScore: number;
  band: RiskBand;
  evaluatedAt: string;
  breakdown: Record<string, number>;
  status_reason?: string;
  [key: string]: unknown;
}

export interface RiskScoreResult {
  score: number;
  band: RiskBand;
  factors: RiskFactorsBreakdown;
  riskType: RiskType;
}

export interface RiskScoringConfig {
  weights?: {
    payment_failed_1?: number; // default +20
    payment_failed_2?: number; // default +20
    days_overdue_3?: number;   // default +15
    amount_high?: number;      // default +10
    customer_active?: number;  // default +10
    historical_payment_success?: number; // default +10
    high_checkout_intent?: number;       // default +15
  };
  thresholds?: {
    amount_high_minor_units?: bigint | number; // default 50_000_00 (₹50,000 in paise)
    checkout_intent_minor_units?: bigint | number; // default 5_000_00 (₹5,000 in paise)
    overdue_days?: number; // default 3
    history_window_days?: number; // default 180
    success_count_threshold?: number; // default 3
  };
}

export interface SubjectAggregates {
  tenantId: string;
  customerId: string;
  customer: Customer;
  payment?: Payment | null;
  invoice?: Invoice | null;
  checkout?: Checkout | null;
  subscriptions?: Subscription[];
  paymentsHistory?: Payment[];
  paymentAttempts?: PaymentAttempt[];
  checkoutEvents?: CheckoutEvent[];
  now?: Date;
}
