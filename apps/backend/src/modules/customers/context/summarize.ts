import type {
  Customer,
  Payment,
  Subscription,
  Invoice,
  Checkout,
  RecoveryCase,
  RecoveryOutcome,
  Message,
  CustomerResponse,
} from "@repo/db";
import { maskEmail, maskPhone } from "./allowlist";
import type {
  CustomerProfileContext,
  PaymentSummaryContext,
  SubscriptionSummaryContext,
  InvoiceSummaryContext,
  CheckoutSummaryContext,
  RecoveryHistoryContext,
  CommunicationHistoryContext,
  PreferencesContext,
} from "./types";

/**
 * Pure aggregation helpers for constructing customer context (Spec 01 §9, s-13).
 * Every summarizer is side-effect free and accepts a deterministic `now: Date` for testing.
 */

export function summarizeCustomerProfile(
  customer: Customer,
  now: Date,
): CustomerProfileContext {
  const createdAtMs = new Date(customer.createdAt).getTime();
  const nowMs = now.getTime();
  const tenureDays = Math.max(0, Math.floor((nowMs - createdAtMs) / (1000 * 60 * 60 * 24)));

  return {
    id: customer.id,
    name: customer.name,
    status: customer.status as CustomerProfileContext["status"],
    lifetime_value_minor: Number(customer.lifetimeValue),
    tenure_days: tenureDays,
    opted_out: customer.optedOut,
    email_masked: maskEmail(customer.email),
    phone_masked: maskPhone(customer.phone),
  };
}

export function summarizePayments(
  payments: Payment[],
  now: Date,
): PaymentSummaryContext {
  const cutoff180d = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);

  let succeeded180d = 0;
  let failed180d = 0;
  let totalPaidMinor = 0;
  let totalPaidCount = 0;
  let sumAllAmountMinor = 0;

  let lastSuccessAt: Date | null = null;
  let lastFailureAt: Date | null = null;
  let lastFailureCode: string | null = null;

  for (const payment of payments) {
    const occurredAt = new Date(payment.occurredAt ?? payment.createdAt);
    const amountMinor = Number(payment.amount);
    sumAllAmountMinor += amountMinor;

    const isSucceeded = payment.status === "SUCCEEDED";
    const isFailed = payment.status === "FAILED";

    if (isSucceeded) {
      totalPaidMinor += amountMinor;
      totalPaidCount++;
      if (occurredAt >= cutoff180d) {
        succeeded180d++;
      }
      const paidDate = payment.paidAt ? new Date(payment.paidAt) : occurredAt;
      if (!lastSuccessAt || paidDate > lastSuccessAt) {
        lastSuccessAt = paidDate;
      }
    } else if (isFailed) {
      if (occurredAt >= cutoff180d) {
        failed180d++;
      }
      if (!lastFailureAt || occurredAt > lastFailureAt) {
        lastFailureAt = occurredAt;
        lastFailureCode = payment.failureCode ?? null;
      }
    }
  }

  const avgAmountMinor =
    totalPaidCount > 0
      ? Math.round(totalPaidMinor / totalPaidCount)
      : payments.length > 0
        ? Math.round(sumAllAmountMinor / payments.length)
        : 0;

  return {
    succeeded_count_180d: succeeded180d,
    failed_count_180d: failed180d,
    last_success_at: lastSuccessAt ? lastSuccessAt.toISOString() : null,
    last_failure_at: lastFailureAt ? lastFailureAt.toISOString() : null,
    last_failure_code: lastFailureCode,
    avg_amount_minor: avgAmountMinor,
    total_paid_minor: totalPaidMinor,
  };
}

export function summarizeSubscriptions(
  subscriptions: Subscription[],
  payments: Payment[],
  _now: Date,
): SubscriptionSummaryContext {
  if (!subscriptions || subscriptions.length === 0) {
    return {
      status: null,
      plan_name: null,
      amount_minor: 0,
      renewals_count: 0,
      past_due_events: 0,
    };
  }

  // Active or latest subscription
  const primarySub =
    subscriptions.find((s) => s.status === "ACTIVE") ?? subscriptions[0];

  const subIds = new Set(subscriptions.map((s) => s.id));

  let renewalsCount = 0;
  let pastDueEvents = 0;

  for (const payment of payments) {
    if (payment.subscriptionId && subIds.has(payment.subscriptionId)) {
      if (payment.status === "SUCCEEDED") {
        renewalsCount++;
      } else if (payment.status === "FAILED") {
        pastDueEvents++;
      }
    }
  }

  // Add past_due subscription statuses if any
  for (const s of subscriptions) {
    if (s.status === "PAST_DUE") {
      pastDueEvents++;
    }
  }

  return {
    status: primarySub.status,
    plan_name: primarySub.planName ?? null,
    amount_minor: Number(primarySub.amount),
    renewals_count: renewalsCount,
    past_due_events: pastDueEvents,
  };
}

export function summarizeInvoices(
  invoices: Invoice[],
  now: Date,
): InvoiceSummaryContext {
  let openCount = 0;
  let overdueCount = 0;
  let worstDaysOverdue = 0;
  let totalOverdueMinor = 0;

  const nowMs = now.getTime();

  for (const inv of invoices) {
    const isClosed = inv.status === "PAID" || inv.status === "CANCELLED";
    if (isClosed) continue;

    openCount++;
    const dueAtMs = new Date(inv.dueAt).getTime();
    const isOverdue = inv.status === "OVERDUE" || dueAtMs < nowMs;

    if (isOverdue) {
      overdueCount++;
      const daysOverdue = Math.max(0, Math.floor((nowMs - dueAtMs) / (1000 * 60 * 60 * 24)));
      if (daysOverdue > worstDaysOverdue) {
        worstDaysOverdue = daysOverdue;
      }
      const remainingMinor = Number(inv.amount) - Number(inv.amountPaid ?? 0n);
      totalOverdueMinor += Math.max(0, remainingMinor);
    }
  }

  return {
    open_count: openCount,
    overdue_count: overdueCount,
    worst_days_overdue: worstDaysOverdue,
    total_overdue_minor: totalOverdueMinor,
  };
}

export function summarizeCheckouts(
  checkouts: Checkout[],
  now: Date,
): CheckoutSummaryContext {
  const cutoff90d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  let activeCarts = 0;
  let abandoned90d = 0;
  let lastCartValueMinor = 0;

  if (checkouts.length > 0) {
    lastCartValueMinor = Number(checkouts[0].cartValue);
  }

  for (const c of checkouts) {
    const isActive = c.status === "STARTED" || c.status === "PAYMENT_STARTED";
    if (isActive) {
      activeCarts++;
    }

    const isAbandoned = c.status === "ABANDONED";
    if (isAbandoned) {
      const actDate = c.abandonedAt
        ? new Date(c.abandonedAt)
        : new Date(c.lastActivityAt ?? c.createdAt);
      if (actDate >= cutoff90d) {
        abandoned90d++;
      }
    }
  }

  return {
    active_carts: activeCarts,
    abandoned_count_90d: abandoned90d,
    last_cart_value_minor: lastCartValueMinor,
  };
}

export function summarizeRecoveryHistory(
  cases: RecoveryCase[],
  outcomes: RecoveryOutcome[],
): RecoveryHistoryContext {
  let recoveredCount = 0;
  let stoppedCount = 0;
  let escalatedCount = 0;

  for (const c of cases) {
    if (c.status === "RECOVERED") {
      recoveredCount++;
    } else if (c.status === "STOPPED") {
      stoppedCount++;
    } else if (c.status === "ESCALATED") {
      escalatedCount++;
    }
  }

  let lastOutcome: RecoveryHistoryContext["last_outcome"] = null;
  if (outcomes.length > 0) {
    const latest = outcomes[0];
    lastOutcome = {
      case_id: latest.caseId,
      amount_recovered_minor: Number(latest.recoveredAmount),
      at: new Date(latest.recoveredAt ?? latest.createdAt).toISOString(),
    };
  }

  const totalCases = cases.length;
  const retrySuccessRate =
    totalCases > 0
      ? Number((recoveredCount / totalCases).toFixed(4))
      : 0;

  return {
    prior_cases: totalCases,
    recovered_cases: recoveredCount,
    stopped_cases: stoppedCount,
    escalated_cases: escalatedCount,
    last_outcome: lastOutcome,
    retry_success_rate: Math.min(1, Math.max(0, retrySuccessRate)),
  };
}

export function summarizeCommunicationHistory(
  messages: Message[],
  responses: CustomerResponse[],
  customer: Customer,
  now: Date,
): CommunicationHistoryContext {
  const cutoff7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const cutoff14d = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  let whatsapp7d = 0;
  let email14d = 0;
  let sms7d = 0;
  let lastContactedAt: Date | null = null;

  for (const m of messages) {
    const sentDate = m.sentAt ? new Date(m.sentAt) : new Date(m.createdAt);

    if (!lastContactedAt || sentDate > lastContactedAt) {
      lastContactedAt = sentDate;
    }

    if (m.channel === "WHATSAPP" && sentDate >= cutoff7d) {
      whatsapp7d++;
    } else if (m.channel === "EMAIL" && sentDate >= cutoff14d) {
      email14d++;
    } else if (m.channel === "SMS" && sentDate >= cutoff7d) {
      sms7d++;
    }
  }

  const replyRate =
    messages.length > 0
      ? Math.min(1, Math.max(0, Number((responses.length / messages.length).toFixed(4))))
      : 0;

  let optOutAt: string | null = null;
  if (customer.optedOut && customer.optedOutAt) {
    optOutAt = new Date(customer.optedOutAt).toISOString();
  } else {
    const optOutResponse = responses.find((r) => r.type === "OPT_OUT");
    if (optOutResponse && optOutResponse.receivedAt) {
      optOutAt = new Date(optOutResponse.receivedAt).toISOString();
    }
  }

  return {
    whatsapp_last_7d: whatsapp7d,
    email_last_14d: email14d,
    sms_last_7d: sms7d,
    last_contacted_at: lastContactedAt ? lastContactedAt.toISOString() : null,
    reply_rate: replyRate,
    opt_out_at: optOutAt,
  };
}

export function summarizePreferences(
  customer: Customer,
  messages: Message[],
): PreferencesContext {
  const metadata = (customer.metadata ?? {}) as Record<string, unknown>;

  const preferredChannel =
    (metadata.preferred_channel as string) ??
    (metadata.preferredChannel as string) ??
    (messages.length > 0 ? messages[0].channel : null) ??
    null;

  const language = (metadata.language as string) ?? "en";

  return {
    preferred_channel: preferredChannel,
    language: language,
  };
}
