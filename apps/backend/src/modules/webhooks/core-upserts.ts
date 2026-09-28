import type { CoreProjections, CheckoutItemProjection } from "./normalize/types";
import type { Repositories } from "../../plugins/db";
import type { RepoContext, CheckoutItem } from "@repo/db";
import { recordEventOrderRegression } from "@repo/observability";

export interface UpsertCoreInput {
  tenantId: string;
  provider: "STRIPE" | "RAZORPAY";
  projections: CoreProjections;
}

export interface UpsertCoreResult {
  customerId?: string;
  paymentId?: string;
  subscriptionId?: string;
  invoiceId?: string;
  checkoutId?: string;
}

// Allowed state transitions: app-memory guard against out-of-order regressions
// (Spec 01 §21, s-10 §State Transitions). Disallowed targets skip the write and record
// an order-regression metric instead. DB-level WHERE-status guards live in the
// risks/cases/actions repos; this path relies on insertEventIfNew dedupe + this skip.
const PAYMENT_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  CREATED: ["PENDING", "FAILED", "SUCCEEDED"],
  PENDING: ["FAILED", "SUCCEEDED", "PENDING"],
  FAILED: ["PENDING", "SUCCEEDED"], // recovery retry can succeed later
  SUCCEEDED: ["REFUNDED", "DISPUTED", "SUCCEEDED"],
  REFUNDED: ["REFUNDED"],
  DISPUTED: ["REFUNDED", "DISPUTED"],
};

const INVOICE_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SENT", "DUE", "OVERDUE", "PAID", "CANCELLED"],
  SENT: ["DUE", "OVERDUE", "PAID", "CANCELLED"],
  DUE: ["OVERDUE", "PAID", "DISPUTED", "CANCELLED", "DUE"],
  OVERDUE: ["PAID", "DISPUTED", "CANCELLED", "OVERDUE"],
  PAID: ["DISPUTED", "PAID"],
  DISPUTED: ["PAID", "CANCELLED", "DISPUTED"],
  CANCELLED: ["CANCELLED"],
};

const CHECKOUT_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  STARTED: ["PAYMENT_STARTED", "ABANDONED", "COMPLETED", "EXPIRED", "STARTED"],
  PAYMENT_STARTED: ["COMPLETED", "ABANDONED", "EXPIRED", "PAYMENT_STARTED"],
  ABANDONED: ["PAYMENT_STARTED", "COMPLETED", "ABANDONED"], // recovery can bring user back
  COMPLETED: ["COMPLETED"],
  EXPIRED: ["STARTED", "EXPIRED"],
};

/**
 * Idempotently upserts financial core records (customers, subscriptions, payments, invoices, checkouts)
 * with guarded conditional state updates and order regression tracking (Spec 01 §7, s-10 §core-upserts).
 */
export async function upsertFinancialCoreRecords(
  ctx: RepoContext,
  repos: Repositories,
  input: UpsertCoreInput,
): Promise<UpsertCoreResult> {
  const { tenantId, provider, projections } = input;

  let customerId: string | undefined;
  let subscriptionId: string | undefined;
  let paymentId: string | undefined;
  let invoiceId: string | undefined;
  let checkoutId: string | undefined;

  // 1. Customer Upsert / Resolution
  if (projections.customer) {
    const custProj = projections.customer;
    const existing = await repos.findCustomerByExternalRef(ctx, {
      tenantId,
      externalRef: custProj.externalRef,
    });

    if (existing) {
      customerId = existing.id;
      // Update contact details if new details are provided
      if (
        (custProj.email && custProj.email !== existing.email) ||
        (custProj.phone && custProj.phone !== existing.phone) ||
        (custProj.name && custProj.name !== existing.name && !existing.name.startsWith("Customer "))
      ) {
        await repos.updateCustomer(ctx, {
          tenantId,
          customerId: existing.id,
          name: custProj.name,
          email: custProj.email,
          phone: custProj.phone,
          metadata: { ...existing.metadata, ...custProj.metadata },
        });
      }
    } else {
      const created = await repos.createCustomer(ctx, {
        tenantId,
        externalRef: custProj.externalRef,
        name: custProj.name,
        email: custProj.email,
        phone: custProj.phone,
        status: "ACTIVE",
        metadata: custProj.metadata,
      });
      customerId = created.id;
    }
  }

  // 2. Subscription Upsert
  if (projections.subscription) {
    const subProj = projections.subscription;
    const existing = await repos.findSubscriptionByProviderId(ctx, {
      tenantId,
      provider,
      providerSubscriptionId: subProj.providerSubscriptionId,
    });

    if (existing) {
      subscriptionId = existing.id;
      await repos.updateSubscriptionStatus(ctx, {
        tenantId,
        subscriptionId: existing.id,
        status: subProj.status,
        currentPeriodStart: subProj.currentPeriodStart,
        currentPeriodEnd: subProj.currentPeriodEnd,
        cancelledAt: subProj.cancelledAt,
      });
    } else if (customerId) {
      const created = await repos.createSubscription(ctx, {
        tenantId,
        customerId,
        provider,
        providerSubscriptionId: subProj.providerSubscriptionId,
        planName: subProj.planName,
        amount: subProj.amount,
        currency: subProj.currency,
        status: subProj.status,
        currentPeriodStart: subProj.currentPeriodStart,
        currentPeriodEnd: subProj.currentPeriodEnd,
        cancelledAt: subProj.cancelledAt,
      });
      subscriptionId = created.id;
    }
  }

  // 3. Payment Upsert & Guarded Status Transitions
  if (projections.payment) {
    const payProj = projections.payment;
    const existing = await repos.findPaymentByProviderPaymentId(ctx, {
      tenantId,
      provider,
      providerPaymentId: payProj.providerPaymentId,
    });

    if (existing) {
      paymentId = existing.id;
      const currentStatus = existing.status;
      const targetStatus = payProj.status;

      // Check for guarded transition vs status regression
      const allowed = PAYMENT_ALLOWED_TRANSITIONS[currentStatus] || [];
      if (currentStatus !== targetStatus && !allowed.includes(targetStatus)) {
        // Status regression detected (e.g. SUCCEEDED delivered before FAILED)
        recordEventOrderRegression(provider, "PAYMENT", currentStatus, targetStatus);
      } else {
        await repos.updatePaymentStatus(ctx, {
          tenantId,
          paymentId: existing.id,
          status: targetStatus,
          failureCode: payProj.failureCode,
          failureMessage: payProj.failureMessage,
          paidAt: payProj.paidAt,
          refundedAt: payProj.refundedAt,
          disputedAt: payProj.disputedAt,
        });
      }
    } else if (customerId) {
      const created = await repos.createPayment(ctx, {
        tenantId,
        customerId,
        subscriptionId,
        amount: payProj.amount,
        currency: payProj.currency,
        status: payProj.status,
        provider,
        providerPaymentId: payProj.providerPaymentId,
        failureCode: payProj.failureCode,
        failureMessage: payProj.failureMessage,
        methodMetadata: payProj.methodMetadata,
        occurredAt: payProj.occurredAt,
        paidAt: payProj.paidAt,
        refundedAt: payProj.refundedAt,
        disputedAt: payProj.disputedAt,
      });
      paymentId = created.id;
    }

    // Create payment attempt row for failed payments if requested
    if (paymentId && payProj.createAttempt) {
      const attempts = await repos.findPaymentAttemptsByPaymentId(ctx, {
        tenantId,
        paymentId,
      });
      const attemptNumber = attempts.length + 1;
      const idempotencyKey = `${tenantId}:${paymentId}:attempt:${attemptNumber}`;

      await repos.createPaymentAttempt(ctx, {
        tenantId,
        paymentId,
        attemptNumber,
        initiatedBy: "PROVIDER_AUTO",
        idempotencyKey,
        status: "FAILED",
        failureCode: payProj.failureCode,
        requestedAt: payProj.occurredAt,
        resolvedAt: payProj.occurredAt,
        error: {
          failure_code: payProj.failureCode,
          failure_message: payProj.failureMessage,
        },
      });
    }
  }

  // 4. Invoice Upsert & Guarded Status Transitions
  if (projections.invoice) {
    const invProj = projections.invoice;
    let existing = invProj.providerInvoiceId
      ? await repos.findInvoiceByProviderId(ctx, {
          tenantId,
          provider,
          providerInvoiceId: invProj.providerInvoiceId,
        })
      : null;

    if (!existing) {
      existing = await repos.findInvoiceByNumber(ctx, {
        tenantId,
        number: invProj.number,
      });
    }

    if (existing) {
      invoiceId = existing.id;
      const currentStatus = existing.status;
      const targetStatus = invProj.status;

      const allowed = INVOICE_ALLOWED_TRANSITIONS[currentStatus] || [];
      if (currentStatus !== targetStatus && !allowed.includes(targetStatus)) {
        recordEventOrderRegression(provider, "INVOICE", currentStatus, targetStatus);
      } else {
        await repos.updateInvoiceStatus(ctx, {
          tenantId,
          invoiceId: existing.id,
          status: targetStatus,
          amountPaid: invProj.amountPaid,
          paidAt: invProj.paidAt,
          disputedAt: invProj.disputedAt,
        });
      }
    } else if (customerId) {
      const created = await repos.createInvoice(ctx, {
        tenantId,
        customerId,
        provider,
        providerInvoiceId: invProj.providerInvoiceId,
        number: invProj.number,
        amount: invProj.amount,
        amountPaid: invProj.amountPaid ?? 0n,
        currency: invProj.currency,
        status: invProj.status,
        issuedAt: invProj.issuedAt,
        dueAt: invProj.dueAt,
        paidAt: invProj.paidAt,
        disputedAt: invProj.disputedAt,
      });
      invoiceId = created.id;
    }
  }

  // 5. Checkout Upsert & Guarded Status Transitions
  if (projections.checkout) {
    const chkProj = projections.checkout;
    const existing = await repos.findCheckoutBySourceRef(ctx, {
      tenantId,
      sourceRef: chkProj.sourceRef,
    });

    if (existing) {
      checkoutId = existing.id;
      const currentStatus = existing.status;
      const targetStatus = chkProj.status;

      const allowed = CHECKOUT_ALLOWED_TRANSITIONS[currentStatus] || [];
      if (currentStatus !== targetStatus && !allowed.includes(targetStatus)) {
        recordEventOrderRegression(provider, "CHECKOUT", currentStatus, targetStatus);
      } else {
        await repos.updateCheckoutStatus(ctx, {
          tenantId,
          checkoutId: existing.id,
          status: targetStatus,
          lastActivityAt: chkProj.lastActivityAt,
          completedAt: chkProj.completedAt,
          abandonedAt: chkProj.abandonedAt,
        });
      }
    } else if (customerId) {
      const checkoutItems: CheckoutItem[] = (chkProj.items || []).map((item) => ({
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        unitAmountMinor: item.unitAmountMinor,
      }));

      const created = await repos.createCheckout(ctx, {
        tenantId,
        customerId,
        sourceRef: chkProj.sourceRef,
        cartValue: chkProj.cartValue,
        currency: chkProj.currency,
        items: checkoutItems,
        status: chkProj.status,
        startedAt: chkProj.startedAt,
        lastActivityAt: chkProj.lastActivityAt,
        completedAt: chkProj.completedAt,
        abandonedAt: chkProj.abandonedAt,
      });
      checkoutId = created.id;
    }
  }

  return {
    customerId,
    paymentId,
    subscriptionId,
    invoiceId,
    checkoutId,
  };
}
