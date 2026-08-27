import type { NormalizedEventResult, CoreProjections } from "./types";
import { createUnmappedResult } from "./unmapped";
import { UnmappablePayloadError } from "../../../lib/errors";

/**
 * Pure normalization function for Stripe webhook events (Spec 01 §7, s-10 §Requirements 3).
 * Maps Stripe event payloads into internal domain event envelopes and core financial projections.
 */
export function normalizeStripeEvent(rawPayload: unknown): NormalizedEventResult {
  if (!rawPayload || typeof rawPayload !== "object") {
    throw new UnmappablePayloadError("Stripe webhook payload is not an object");
  }

  const event = rawPayload as Record<string, any>;
  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = typeof event.type === "string" ? event.type : "";

  if (!eventId || !eventType) {
    throw new UnmappablePayloadError("Stripe webhook missing 'id' or 'type'");
  }

  const occurredAt = event.created
    ? new Date(typeof event.created === "number" ? event.created * 1000 : event.created)
    : new Date();

  const dataObj = event.data?.object;
  if (!dataObj || typeof dataObj !== "object") {
    return createUnmappedResult(eventId, eventType, event, "Stripe event data.object missing");
  }

  const projections: CoreProjections = {};

  // 1. Customer resolution projection
  const rawCustomerId =
    typeof dataObj.customer === "string"
      ? dataObj.customer
      : typeof dataObj.customer === "object" && dataObj.customer?.id
        ? dataObj.customer.id
        : typeof dataObj.customer_details?.email === "string"
          ? dataObj.customer_details.email
          : undefined;

  if (rawCustomerId) {
    projections.customer = {
      externalRef: rawCustomerId,
      name:
        dataObj.customer_details?.name ||
        dataObj.billing_details?.name ||
        dataObj.customer_name ||
        `Stripe Customer ${rawCustomerId}`,
      email:
        dataObj.customer_details?.email ||
        dataObj.billing_details?.email ||
        dataObj.customer_email ||
        (rawCustomerId.includes("@") ? rawCustomerId : undefined),
      phone:
        dataObj.customer_details?.phone ||
        dataObj.billing_details?.phone ||
        dataObj.customer_phone ||
        undefined,
      metadata: {
        stripe_customer_id: rawCustomerId,
      },
    };
  }

  // 2. Event type specific mappings
  switch (eventType) {
    // Payment failure
    case "payment_intent.payment_failed": {
      const providerPaymentId = dataObj.id || eventId;
      const amount = BigInt(dataObj.amount || 0);
      const currency = (dataObj.currency || "usd").toUpperCase();
      const lastError = dataObj.last_payment_error || {};
      const failureCode = lastError.decline_code || lastError.code || "payment_failed";
      const failureMessage = lastError.message || "Payment intent failed";

      projections.payment = {
        providerPaymentId,
        amount,
        currency,
        status: "FAILED",
        failureCode,
        failureMessage,
        methodMetadata: {
          payment_method_type: dataObj.payment_method_types?.[0],
          payment_method: dataObj.payment_method,
        },
        occurredAt,
        createAttempt: true,
      };

      return {
        externalEventId: eventId,
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
          customer_ref: rawCustomerId,
          status: "FAILED",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Payment succeeded
    case "payment_intent.succeeded": {
      const providerPaymentId = dataObj.id || eventId;
      const amount = BigInt(dataObj.amount || 0);
      const currency = (dataObj.currency || "usd").toUpperCase();

      projections.payment = {
        providerPaymentId,
        amount,
        currency,
        status: "SUCCEEDED",
        occurredAt,
        paidAt: occurredAt,
      };

      return {
        externalEventId: eventId,
        eventType: "payment.succeeded",
        occurredAt,
        entityType: "PAYMENT",
        entityId: providerPaymentId,
        payload: {
          provider_payment_id: providerPaymentId,
          amount: Number(amount),
          currency,
          customer_ref: rawCustomerId,
          status: "SUCCEEDED",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Payment pending / processing
    case "payment_intent.amount_capturable_updated":
    case "payment_intent.processing": {
      const providerPaymentId = dataObj.id || eventId;
      const amount = BigInt(dataObj.amount || 0);
      const currency = (dataObj.currency || "usd").toUpperCase();

      projections.payment = {
        providerPaymentId,
        amount,
        currency,
        status: "PENDING",
        occurredAt,
      };

      return {
        externalEventId: eventId,
        eventType: "payment.pending",
        occurredAt,
        entityType: "PAYMENT",
        entityId: providerPaymentId,
        payload: {
          provider_payment_id: providerPaymentId,
          amount: Number(amount),
          currency,
          customer_ref: rawCustomerId,
          status: "PENDING",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Payment created
    case "payment_intent.created": {
      const providerPaymentId = dataObj.id || eventId;
      const amount = BigInt(dataObj.amount || 0);
      const currency = (dataObj.currency || "usd").toUpperCase();

      projections.payment = {
        providerPaymentId,
        amount,
        currency,
        status: "CREATED",
        occurredAt,
      };

      return {
        externalEventId: eventId,
        eventType: "payment.created",
        occurredAt,
        entityType: "PAYMENT",
        entityId: providerPaymentId,
        payload: {
          provider_payment_id: providerPaymentId,
          amount: Number(amount),
          currency,
          customer_ref: rawCustomerId,
          status: "CREATED",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Payment refunded
    case "charge.refunded": {
      const providerPaymentId = dataObj.payment_intent || dataObj.id || eventId;
      const amount = BigInt(dataObj.amount || 0);
      const currency = (dataObj.currency || "usd").toUpperCase();

      projections.payment = {
        providerPaymentId,
        amount,
        currency,
        status: "REFUNDED",
        occurredAt,
        refundedAt: occurredAt,
      };

      return {
        externalEventId: eventId,
        eventType: "payment.refunded",
        occurredAt,
        entityType: "PAYMENT",
        entityId: providerPaymentId,
        payload: {
          provider_payment_id: providerPaymentId,
          amount: Number(amount),
          currency,
          customer_ref: rawCustomerId,
          status: "REFUNDED",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Payment disputed
    case "charge.dispute.created": {
      const providerPaymentId = dataObj.payment_intent || dataObj.charge || eventId;
      const amount = BigInt(dataObj.amount || 0);
      const currency = (dataObj.currency || "usd").toUpperCase();

      projections.payment = {
        providerPaymentId,
        amount,
        currency,
        status: "DISPUTED",
        occurredAt,
        disputedAt: occurredAt,
      };

      return {
        externalEventId: eventId,
        eventType: "payment.disputed",
        occurredAt,
        entityType: "PAYMENT",
        entityId: providerPaymentId,
        payload: {
          provider_payment_id: providerPaymentId,
          amount: Number(amount),
          currency,
          customer_ref: rawCustomerId,
          status: "DISPUTED",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Subscription created
    case "customer.subscription.created": {
      const providerSubscriptionId = dataObj.id || eventId;
      const plan = dataObj.items?.data?.[0]?.plan || {};
      const amount = BigInt(plan.amount || dataObj.plan?.amount || 0);
      const currency = (plan.currency || dataObj.plan?.currency || "usd").toUpperCase();

      projections.subscription = {
        providerSubscriptionId,
        planName: plan.nickname || dataObj.plan?.nickname || "Default Plan",
        amount,
        currency,
        status: "ACTIVE",
        currentPeriodStart: dataObj.current_period_start
          ? new Date(dataObj.current_period_start * 1000)
          : occurredAt,
        currentPeriodEnd: dataObj.current_period_end
          ? new Date(dataObj.current_period_end * 1000)
          : undefined,
      };

      return {
        externalEventId: eventId,
        eventType: "subscription.created",
        occurredAt,
        entityType: "SUBSCRIPTION",
        entityId: providerSubscriptionId,
        payload: {
          provider_subscription_id: providerSubscriptionId,
          customer_ref: rawCustomerId,
          status: "ACTIVE",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Subscription renewed / updated
    case "customer.subscription.updated": {
      const providerSubscriptionId = dataObj.id || eventId;
      const plan = dataObj.items?.data?.[0]?.plan || {};
      const amount = BigInt(plan.amount || dataObj.plan?.amount || 0);
      const currency = (plan.currency || dataObj.plan?.currency || "usd").toUpperCase();
      const status =
        dataObj.status === "past_due" || dataObj.status === "unpaid"
          ? "PAST_DUE"
          : dataObj.status === "incomplete"
            ? "INCOMPLETE"
            : dataObj.status === "paused"
              ? "PAUSED"
              : dataObj.status === "canceled"
                ? "CANCELLED"
                : "ACTIVE";

      const internalEventType =
        status === "PAST_DUE"
          ? "subscription.payment_failed"
          : "subscription.renewed";

      projections.subscription = {
        providerSubscriptionId,
        planName: plan.nickname || dataObj.plan?.nickname || "Default Plan",
        amount,
        currency,
        status,
        currentPeriodStart: dataObj.current_period_start
          ? new Date(dataObj.current_period_start * 1000)
          : occurredAt,
        currentPeriodEnd: dataObj.current_period_end
          ? new Date(dataObj.current_period_end * 1000)
          : undefined,
      };

      return {
        externalEventId: eventId,
        eventType: internalEventType,
        occurredAt,
        entityType: "SUBSCRIPTION",
        entityId: providerSubscriptionId,
        payload: {
          provider_subscription_id: providerSubscriptionId,
          customer_ref: rawCustomerId,
          status,
        },
        projections,
        isUnmapped: false,
      };
    }

    // Subscription cancelled
    case "customer.subscription.deleted": {
      const providerSubscriptionId = dataObj.id || eventId;
      const plan = dataObj.items?.data?.[0]?.plan || {};
      const amount = BigInt(plan.amount || dataObj.plan?.amount || 0);
      const currency = (plan.currency || dataObj.plan?.currency || "usd").toUpperCase();

      projections.subscription = {
        providerSubscriptionId,
        planName: plan.nickname || dataObj.plan?.nickname || "Default Plan",
        amount,
        currency,
        status: "CANCELLED",
        cancelledAt: dataObj.canceled_at ? new Date(dataObj.canceled_at * 1000) : occurredAt,
      };

      return {
        externalEventId: eventId,
        eventType: "subscription.cancelled",
        occurredAt,
        entityType: "SUBSCRIPTION",
        entityId: providerSubscriptionId,
        payload: {
          provider_subscription_id: providerSubscriptionId,
          customer_ref: rawCustomerId,
          status: "CANCELLED",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Invoice paid
    case "invoice.paid": {
      const providerInvoiceId = dataObj.id || eventId;
      const invoiceNumber = dataObj.number || providerInvoiceId;
      const amount = BigInt(dataObj.amount_due || dataObj.total || 0);
      const amountPaid = BigInt(dataObj.amount_paid || dataObj.total || 0);
      const currency = (dataObj.currency || "usd").toUpperCase();

      projections.invoice = {
        providerInvoiceId,
        number: invoiceNumber,
        amount,
        amountPaid,
        currency,
        status: "PAID",
        dueAt: dataObj.due_date ? new Date(dataObj.due_date * 1000) : occurredAt,
        paidAt: occurredAt,
      };

      return {
        externalEventId: eventId,
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
          customer_ref: rawCustomerId,
          status: "PAID",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Invoice payment failed / overdue
    case "invoice.payment_failed":
    case "invoice.marked_uncollectible": {
      const providerInvoiceId = dataObj.id || eventId;
      const invoiceNumber = dataObj.number || providerInvoiceId;
      const amount = BigInt(dataObj.amount_due || dataObj.total || 0);
      const amountPaid = BigInt(dataObj.amount_paid || 0);
      const currency = (dataObj.currency || "usd").toUpperCase();

      projections.invoice = {
        providerInvoiceId,
        number: invoiceNumber,
        amount,
        amountPaid,
        currency,
        status: "OVERDUE",
        dueAt: dataObj.due_date ? new Date(dataObj.due_date * 1000) : occurredAt,
      };

      return {
        externalEventId: eventId,
        eventType: "invoice.overdue",
        occurredAt,
        entityType: "INVOICE",
        entityId: providerInvoiceId,
        payload: {
          provider_invoice_id: providerInvoiceId,
          invoice_number: invoiceNumber,
          amount: Number(amount),
          currency,
          customer_ref: rawCustomerId,
          status: "OVERDUE",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Invoice created / finalized (due)
    case "invoice.created":
    case "invoice.finalized": {
      const providerInvoiceId = dataObj.id || eventId;
      const invoiceNumber = dataObj.number || providerInvoiceId;
      const amount = BigInt(dataObj.amount_due || dataObj.total || 0);
      const currency = (dataObj.currency || "usd").toUpperCase();
      const isFinalized = eventType === "invoice.finalized";

      projections.invoice = {
        providerInvoiceId,
        number: invoiceNumber,
        amount,
        amountPaid: 0n,
        currency,
        status: isFinalized ? "DUE" : "DRAFT",
        issuedAt: occurredAt,
        dueAt: dataObj.due_date ? new Date(dataObj.due_date * 1000) : occurredAt,
      };

      return {
        externalEventId: eventId,
        eventType: isFinalized ? "invoice.due" : "invoice.created",
        occurredAt,
        entityType: "INVOICE",
        entityId: providerInvoiceId,
        payload: {
          provider_invoice_id: providerInvoiceId,
          invoice_number: invoiceNumber,
          amount: Number(amount),
          currency,
          customer_ref: rawCustomerId,
          status: isFinalized ? "DUE" : "DRAFT",
        },
        projections,
        isUnmapped: false,
      };
    }

    // Checkout completed
    case "checkout.session.completed": {
      const sourceRef = dataObj.client_reference_id || dataObj.id || eventId;
      const cartValue = BigInt(dataObj.amount_total || 0);
      const currency = (dataObj.currency || "usd").toUpperCase();

      projections.checkout = {
        sourceRef,
        cartValue,
        currency,
        status: "COMPLETED",
        startedAt: occurredAt,
        lastActivityAt: occurredAt,
        completedAt: occurredAt,
      };

      return {
        externalEventId: eventId,
        eventType: "checkout.completed",
        occurredAt,
        entityType: "CHECKOUT",
        entityId: sourceRef,
        payload: {
          source_ref: sourceRef,
          cart_value: Number(cartValue),
          currency,
          customer_ref: rawCustomerId,
          status: "COMPLETED",
        },
        projections,
        isUnmapped: false,
      };
    }

    default:
      return createUnmappedResult(
        eventId,
        eventType,
        event,
        `Unmapped Stripe event type: ${eventType}`,
      );
  }
}
