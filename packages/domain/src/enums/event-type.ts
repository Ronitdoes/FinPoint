export const EVENT_TYPES = [
  "payment.created",
  "payment.pending",
  "payment.failed",
  "payment.succeeded",
  "payment.refunded",
  "payment.disputed",
  "checkout.started",
  "checkout.item_added",
  "checkout.payment_started",
  "checkout.abandoned",
  "checkout.completed",
  "subscription.created",
  "subscription.payment_failed",
  "subscription.renewed",
  "subscription.cancelled",
  "invoice.created",
  "invoice.due",
  "invoice.overdue",
  "invoice.paid",
  "invoice.disputed",
  "customer.replied",
  "customer.opted_out",
  "customer.payment_method_changed",
  "customer_promised_to_pay",
  "customer_payment_received",
  "risk.calculated",
  "UNMAPPED",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const PAYMENT_EVENT_TYPES = EVENT_TYPES.filter((type) =>
  type.startsWith("payment."),
) as readonly (typeof EVENT_TYPES)[number][];

export const CHECKOUT_EVENT_TYPES = EVENT_TYPES.filter((type) =>
  type.startsWith("checkout."),
) as readonly (typeof EVENT_TYPES)[number][];

export const SUBSCRIPTION_EVENT_TYPES = EVENT_TYPES.filter((type) =>
  type.startsWith("subscription."),
) as readonly (typeof EVENT_TYPES)[number][];

export const INVOICE_EVENT_TYPES = EVENT_TYPES.filter((type) =>
  type.startsWith("invoice."),
) as readonly (typeof EVENT_TYPES)[number][];

export const CUSTOMER_EVENT_TYPES = EVENT_TYPES.filter(
  (type) => type.startsWith("customer.") || type.startsWith("customer_"),
) as readonly (typeof EVENT_TYPES)[number][];

export const RISK_EVENT_TYPES = EVENT_TYPES.filter((type) =>
  type.startsWith("risk."),
) as readonly (typeof EVENT_TYPES)[number][];

export const UNMAPPED_EVENT_TYPES = ["UNMAPPED"] as const;

export function isEventType(value: unknown): value is EventType {
  return (
    typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value)
  );
}
