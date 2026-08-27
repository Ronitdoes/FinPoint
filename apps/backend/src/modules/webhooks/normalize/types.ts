import type { EntityType, EventType, SubscriptionStatus } from "@repo/domain";

export interface CustomerProjection {
  externalRef: string;
  name: string;
  email?: string;
  phone?: string;
  metadata?: Record<string, unknown>;
}

export interface PaymentProjection {
  providerPaymentId: string;
  amount: bigint;
  currency: string;
  status: "CREATED" | "PENDING" | "SUCCEEDED" | "FAILED" | "REFUNDED" | "DISPUTED";
  failureCode?: string;
  failureMessage?: string;
  methodMetadata?: Record<string, unknown>;
  occurredAt: Date;
  paidAt?: Date;
  refundedAt?: Date;
  disputedAt?: Date;
  subscriptionExternalRef?: string;
  createAttempt?: boolean;
}

export interface SubscriptionProjection {
  providerSubscriptionId: string;
  planName?: string;
  amount: bigint;
  currency: string;
  status: SubscriptionStatus;
  currentPeriodStart?: Date;
  currentPeriodEnd?: Date;
  cancelledAt?: Date;
}

export interface InvoiceProjection {
  providerInvoiceId?: string;
  number: string;
  amount: bigint;
  amountPaid?: bigint;
  currency: string;
  status: "DRAFT" | "SENT" | "DUE" | "OVERDUE" | "PAID" | "DISPUTED" | "CANCELLED";
  issuedAt?: Date;
  dueAt: Date;
  paidAt?: Date;
  disputedAt?: Date;
}

export interface CheckoutItemProjection {
  sku: string;
  name: string;
  quantity: number;
  unitAmountMinor: number | string;
  [key: string]: unknown;
}

export interface CheckoutProjection {
  sourceRef: string;
  cartValue: bigint;
  currency: string;
  items?: CheckoutItemProjection[];
  status: "STARTED" | "PAYMENT_STARTED" | "ABANDONED" | "COMPLETED" | "EXPIRED";
  startedAt: Date;
  lastActivityAt: Date;
  completedAt?: Date;
  abandonedAt?: Date;
}

export interface CoreProjections {
  customer?: CustomerProjection;
  payment?: PaymentProjection;
  subscription?: SubscriptionProjection;
  invoice?: InvoiceProjection;
  checkout?: CheckoutProjection;
}

export interface NormalizedEventResult {
  externalEventId: string;
  eventType: EventType;
  occurredAt: Date;
  entityType?: EntityType;
  entityId?: string;
  payload: Record<string, unknown>;
  projections: CoreProjections;
  isUnmapped: boolean;
  unmappedReason?: string;
}
