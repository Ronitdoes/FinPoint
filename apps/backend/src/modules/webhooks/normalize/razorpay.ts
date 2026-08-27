import type { NormalizedEventResult, CoreProjections } from "./types";
import { createUnmappedResult } from "./unmapped";
import { UnmappablePayloadError } from "../../../lib/errors";

/**
 * Pure normalization function for Razorpay webhook events (Spec 01 §7, s-10 §Requirements 3).
 * Maps Razorpay event payloads into internal domain event envelopes and core financial projections.
 */
export function normalizeRazorpayEvent(rawPayload: unknown): NormalizedEventResult {
  if (!rawPayload || typeof rawPayload !== "object") {
    throw new UnmappablePayloadError("Razorpay webhook payload is not an object");
  }

  const event = rawPayload as Record<string, any>;
  const eventType = typeof event.event === "string" ? event.event : "";

  if (!eventType) {
    throw new UnmappablePayloadError("Razorpay webhook missing 'event' field");
  }

  const occurredAt = event.created_at
    ? new Date(typeof event.created_at === "number" ? event.created_at * 1000 : event.created_at)
    : new Date();

  const payload = event.payload || {};
  const paymentEntity = payload.payment?.entity;
  const refundEntity = payload.refund?.entity;
  const subscriptionEntity = payload.subscription?.entity;
  const invoiceEntity = payload.invoice?.entity;

  const entityId =
    paymentEntity?.id ||
    refundEntity?.id ||
    subscriptionEntity?.id ||
    invoiceEntity?.id ||
    "";

  // Derive unique externalEventId from payload ID or deterministic composite
  const externalEventId =
    typeof event.id === "string"
      ? event.id
      : typeof event.event_id === "string"
        ? event.event_id
        : `rp_${eventType}_${entityId || "event"}_${event.created_at || occurredAt.getTime()}`;

  const projections: CoreProjections = {};

  // 1. Customer resolution projection
  const customerRef =
    paymentEntity?.customer_id ||
    subscriptionEntity?.customer_id ||
    invoiceEntity?.customer_id ||
    paymentEntity?.email ||
    paymentEntity?.contact ||
    undefined;

  if (customerRef) {
    projections.customer = {
      externalRef: customerRef,
      name:
        paymentEntity?.notes?.name ||
        paymentEntity?.email ||
        paymentEntity?.contact ||
        `Razorpay Customer ${customerRef}`,
      email: paymentEntity?.email || (customerRef.includes("@") ? customerRef : undefined),
      phone: paymentEntity?.contact,
      metadata: {
        razorpay_customer_id: customerRef,
      },
    };
  }

  // 2. Event type specific mappings
  switch (eventType) {
    // Payment failed
    case "payment.failed": {
      const providerPaymentId = paymentEntity?.id || externalEventId;
      const amount = BigInt(paymentEntity?.amount || 0);
      const currency = (paymentEntity?.currency || "INR").toUpperCase();
      const failureCode = paymentEntity?.error_code || "payment_failed";
      const failureMessage = paymentEntity?.error_description || "Razorpay payment failed";

      projections.payment = {
        providerPaymentId,
        amount,
        currency,
        status: "FAILED",
        failureCode,
        failureMessage,
        methodMetadata: {
          method: paymentEntity?.method,
          bank: paymentEntity?.bank,
          wallet: paymentEntity?.wallet,
          vpa: paymentEntity?.vpa,
        },
        occurredAt,
        createAttempt: true,
      };

      return {
        externalEventId,
        eventType: "payment.failed",
        occurredAt,
        entityType: "PAYMENT",
        entityId: providerPaymentId,
        payload: {
          provider_payment_id: providerPaymentId,
          amount: Number(amount),
          currency,
          failure_code: failureCode,
          failure_message: failureMessage,
          customer_ref: customerRef,
          status: "FAILED",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Payment captured (succeeded)
    case "payment.captured": {
      const providerPaymentId = paymentEntity?.id || externalEventId;
      const amount = BigInt(paymentEntity?.amount || 0);
      const currency = (paymentEntity?.currency || "INR").toUpperCase();

      projections.payment = {
        providerPaymentId,
        amount,
        currency,
        status: "SUCCEEDED",
        occurredAt,
        paidAt: occurredAt,
      };

      return {
        externalEventId,
        eventType: "payment.succeeded",
        occurredAt,
        entityType: "PAYMENT",
        entityId: providerPaymentId,
        payload: {
          provider_payment_id: providerPaymentId,
          amount: Number(amount),
          currency,
          customer_ref: customerRef,
          status: "SUCCEEDED",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Payment authorized (pending capture)
    case "payment.authorized": {
      const providerPaymentId = paymentEntity?.id || externalEventId;
      const amount = BigInt(paymentEntity?.amount || 0);
      const currency = (paymentEntity?.currency || "INR").toUpperCase();

      projections.payment = {
        providerPaymentId,
        amount,
        currency,
        status: "PENDING",
        occurredAt,
      };

      return {
        externalEventId,
        eventType: "payment.pending",
        occurredAt,
        entityType: "PAYMENT",
        entityId: providerPaymentId,
        payload: {
          provider_payment_id: providerPaymentId,
          amount: Number(amount),
          currency,
          customer_ref: customerRef,
          status: "PENDING",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Payment created
    case "payment.created": {
      const providerPaymentId = paymentEntity?.id || externalEventId;
      const amount = BigInt(paymentEntity?.amount || 0);
      const currency = (paymentEntity?.currency || "INR").toUpperCase();

      projections.payment = {
        providerPaymentId,
        amount,
        currency,
        status: "CREATED",
        occurredAt,
      };

      return {
        externalEventId,
        eventType: "payment.created",
        occurredAt,
        entityType: "PAYMENT",
        entityId: providerPaymentId,
        payload: {
          provider_payment_id: providerPaymentId,
          amount: Number(amount),
          currency,
          customer_ref: customerRef,
          status: "CREATED",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Refund processed
    case "refund.processed": {
      const providerPaymentId = refundEntity?.payment_id || paymentEntity?.id || externalEventId;
      const amount = BigInt(refundEntity?.amount || paymentEntity?.amount || 0);
      const currency = (refundEntity?.currency || paymentEntity?.currency || "INR").toUpperCase();

      projections.payment = {
        providerPaymentId,
        amount,
        currency,
        status: "REFUNDED",
        occurredAt,
        refundedAt: occurredAt,
      };

      return {
        externalEventId,
        eventType: "payment.refunded",
        occurredAt,
        entityType: "PAYMENT",
        entityId: providerPaymentId,
        payload: {
          provider_payment_id: providerPaymentId,
          amount: Number(amount),
          currency,
          customer_ref: customerRef,
          status: "REFUNDED",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Subscription authenticated / activated (created)
    case "subscription.authenticated":
    case "subscription.activated": {
      const providerSubscriptionId = subscriptionEntity?.id || externalEventId;
      const amount = BigInt(subscriptionEntity?.plan?.item?.amount || subscriptionEntity?.amount || 0);
      const currency = (
        subscriptionEntity?.plan?.item?.currency ||
        subscriptionEntity?.currency ||
        "INR"
      ).toUpperCase();

      projections.subscription = {
        providerSubscriptionId,
        planName: subscriptionEntity?.plan?.item?.name || "Subscription Plan",
        amount,
        currency,
        status: "ACTIVE",
        currentPeriodStart: subscriptionEntity?.current_start
          ? new Date(subscriptionEntity.current_start * 1000)
          : occurredAt,
        currentPeriodEnd: subscriptionEntity?.current_end
          ? new Date(subscriptionEntity.current_end * 1000)
          : undefined,
      };

      return {
        externalEventId,
        eventType: "subscription.created",
        occurredAt,
        entityType: "SUBSCRIPTION",
        entityId: providerSubscriptionId,
        payload: {
          provider_subscription_id: providerSubscriptionId,
          customer_ref: customerRef,
          status: "ACTIVE",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Subscription charged (renewed)
    case "subscription.charged": {
      const providerSubscriptionId = subscriptionEntity?.id || externalEventId;
      const amount = BigInt(subscriptionEntity?.plan?.item?.amount || subscriptionEntity?.amount || 0);
      const currency = (
        subscriptionEntity?.plan?.item?.currency ||
        subscriptionEntity?.currency ||
        "INR"
      ).toUpperCase();

      projections.subscription = {
        providerSubscriptionId,
        planName: subscriptionEntity?.plan?.item?.name || "Subscription Plan",
        amount,
        currency,
        status: "ACTIVE",
        currentPeriodStart: subscriptionEntity?.current_start
          ? new Date(subscriptionEntity.current_start * 1000)
          : occurredAt,
        currentPeriodEnd: subscriptionEntity?.current_end
          ? new Date(subscriptionEntity.current_end * 1000)
          : undefined,
      };

      return {
        externalEventId,
        eventType: "subscription.renewed",
        occurredAt,
        entityType: "SUBSCRIPTION",
        entityId: providerSubscriptionId,
        payload: {
          provider_subscription_id: providerSubscriptionId,
          customer_ref: customerRef,
          status: "ACTIVE",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Subscription cancelled / halted / pending
    case "subscription.cancelled":
    case "subscription.halted":
    case "subscription.pending": {
      const providerSubscriptionId = subscriptionEntity?.id || externalEventId;
      const amount = BigInt(subscriptionEntity?.plan?.item?.amount || subscriptionEntity?.amount || 0);
      const currency = (
        subscriptionEntity?.plan?.item?.currency ||
        subscriptionEntity?.currency ||
        "INR"
      ).toUpperCase();
      const isCancelled = eventType === "subscription.cancelled";
      const status = isCancelled ? "CANCELLED" : "PAST_DUE";

      projections.subscription = {
        providerSubscriptionId,
        planName: subscriptionEntity?.plan?.item?.name || "Subscription Plan",
        amount,
        currency,
        status,
        cancelledAt: isCancelled ? occurredAt : undefined,
      };

      return {
        externalEventId,
        eventType: isCancelled ? "subscription.cancelled" : "subscription.payment_failed",
        occurredAt,
        entityType: "SUBSCRIPTION",
        entityId: providerSubscriptionId,
        payload: {
          provider_subscription_id: providerSubscriptionId,
          customer_ref: customerRef,
          status,
        },
        projections,
        isUnmapped: false,
      };
    }

    // Invoice paid
    case "invoice.paid": {
      const providerInvoiceId = invoiceEntity?.id || externalEventId;
      const invoiceNumber = invoiceEntity?.invoice_number || providerInvoiceId;
      const amount = BigInt(invoiceEntity?.amount || 0);
      const amountPaid = BigInt(invoiceEntity?.amount_paid || invoiceEntity?.amount || 0);
      const currency = (invoiceEntity?.currency || "INR").toUpperCase();

      projections.invoice = {
        providerInvoiceId,
        number: invoiceNumber,
        amount,
        amountPaid,
        currency,
        status: "PAID",
        dueAt: invoiceEntity?.due_date ? new Date(invoiceEntity.due_date * 1000) : occurredAt,
        paidAt: occurredAt,
      };

      return {
        externalEventId,
        eventType: "invoice.paid",
        occurredAt,
        entityType: "INVOICE",
        entityId: providerInvoiceId,
        payload: {
          provider_invoice_id: providerInvoiceId,
          invoice_number: invoiceNumber,
          amount: Number(amount),
          amount_paid: Number(amountPaid),
          currency,
          customer_ref: customerRef,
          status: "PAID",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Invoice issued (due)
    case "invoice.issued": {
      const providerInvoiceId = invoiceEntity?.id || externalEventId;
      const invoiceNumber = invoiceEntity?.invoice_number || providerInvoiceId;
      const amount = BigInt(invoiceEntity?.amount || 0);
      const currency = (invoiceEntity?.currency || "INR").toUpperCase();

      projections.invoice = {
        providerInvoiceId,
        number: invoiceNumber,
        amount,
        amountPaid: 0n,
        currency,
        status: "DUE",
        issuedAt: occurredAt,
        dueAt: invoiceEntity?.due_date ? new Date(invoiceEntity.due_date * 1000) : occurredAt,
      };

      return {
        externalEventId,
        eventType: "invoice.due",
        occurredAt,
        entityType: "INVOICE",
        entityId: providerInvoiceId,
        payload: {
          provider_invoice_id: providerInvoiceId,
          invoice_number: invoiceNumber,
          amount: Number(amount),
          currency,
          customer_ref: customerRef,
          status: "DUE",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Invoice expired / overdue
    case "invoice.expired":
    case "invoice.partially_paid": {
      const providerInvoiceId = invoiceEntity?.id || externalEventId;
      const invoiceNumber = invoiceEntity?.invoice_number || providerInvoiceId;
      const amount = BigInt(invoiceEntity?.amount || 0);
      const amountPaid = BigInt(invoiceEntity?.amount_paid || 0);
      const currency = (invoiceEntity?.currency || "INR").toUpperCase();

      projections.invoice = {
        providerInvoiceId,
        number: invoiceNumber,
        amount,
        amountPaid,
        currency,
        status: "OVERDUE",
        dueAt: invoiceEntity?.due_date ? new Date(invoiceEntity.due_date * 1000) : occurredAt,
      };

      return {
        externalEventId,
        eventType: "invoice.overdue",
        occurredAt,
        entityType: "INVOICE",
        entityId: providerInvoiceId,
        payload: {
          provider_invoice_id: providerInvoiceId,
          invoice_number: invoiceNumber,
          amount: Number(amount),
          currency,
          customer_ref: customerRef,
          status: "OVERDUE",
        },
        projections,
        isUnmapped: false,
      };
    }

    default:
      return createUnmappedResult(
        externalEventId,
        eventType,
        event,
        `Unmapped Razorpay event type: ${eventType}`,
      );
  }
}
