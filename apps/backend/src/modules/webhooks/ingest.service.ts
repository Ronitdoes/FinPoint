import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "@repo/db";
import type { DomainEvent, EntityType } from "@repo/domain";
import type { EventBus } from "@repo/integrations";
import {
  withSpan,
  recordEventIngested,
  recordEventDuplicate,
  recordTenantFallback,
  recordWebhookDelivery,
  recordWebhookLatency,
} from "@repo/observability";
import type { Repositories } from "../../plugins/db";
import { verifyStripeSignature } from "./verify-stripe";
import { verifyRazorpaySignature } from "./verify-razorpay";
import { normalizeStripeEvent } from "./normalize/stripe";
import { normalizeRazorpayEvent } from "./normalize/razorpay";
import { upsertFinancialCoreRecords, type UpsertCoreResult } from "./core-upserts";
import { UnmappablePayloadError } from "../../lib/errors";
import type { NormalizedEventResult } from "./normalize/types";

export interface IngestWebhookInput {
  provider: "STRIPE" | "RAZORPAY";
  rawBody: string | Buffer;
  headers: Record<string, string | string[] | undefined>;
  queryTenantId?: string;
  correlationId?: string;
  traceparent?: string;
}

export interface IngestWebhookDependencies {
  db: Database;
  repos: Repositories;
  eventBus: EventBus;
  logger: FastifyBaseLogger;
  stripeWebhookSecret?: string | null;
  razorpayWebhookSecret?: string | null;
}

export interface IngestWebhookResponse {
  status: "ACCEPTED" | "DUPLICATE";
  eventId: string;
}

/**
 * Orchestrates webhook verification, pure normalization, core upserts,
 * database idempotency, and asynchronous event bus dispatch (Spec 01 §7, s-10).
 */
export async function processInboundWebhook(
  deps: IngestWebhookDependencies,
  input: IngestWebhookInput,
): Promise<IngestWebhookResponse> {
  const startTime = Date.now();
  const { provider, rawBody, headers, queryTenantId } = input;
  const correlationId = input.correlationId || randomUUID();

  // 1. Signature verification per provider (constant-time, ±5m tolerance for Stripe)
  await withSpan(`webhook.verify.${provider.toLowerCase()}`, {}, async () => {
    if (provider === "STRIPE") {
      const sigHeader = (headers["stripe-signature"] || headers["Stripe-Signature"]) as
        | string
        | undefined;
      verifyStripeSignature(rawBody, sigHeader, deps.stripeWebhookSecret);
    } else if (provider === "RAZORPAY") {
      const sigHeader = (headers["x-razorpay-signature"] || headers["X-Razorpay-Signature"]) as
        | string
        | undefined;
      verifyRazorpaySignature(rawBody, sigHeader, deps.razorpayWebhookSecret);
    }
  });

  // 2. Parse payload safely & execute pure normalization
  const normalized: NormalizedEventResult = await withSpan(
    `webhook.normalize.${provider.toLowerCase()}`,
    {},
    async () => {
      const rawStr = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
      let json: unknown;
      try {
        json = JSON.parse(rawStr);
      } catch {
        // s-10 audit fix (intentional fail-closed, documented in
        // docs/explanation/s-10-explanation.md §13): transport-level malformed
        // JSON is rejected with UNMAPPABLE_PAYLOAD WITHOUT persisting a FAILED
        // row. No reliable tenant/external_event_id can be derived from
        // unparseable bytes, so storing would create phantom rows outside the
        // (source, external_event_id) idempotency anchor. Observability is
        // preserved via the unmappable delivery counter + WARN log below.
        // (Note: over HTTP, app.ts's buffer parser already rejects unparseable
        // bodies with 400 before this branch; this covers direct invocations.)
        recordWebhookDelivery(provider, "unmappable");
        deps.logger.warn(
          { provider, correlationId },
          "Inbound webhook rejected: malformed JSON payload (no event row stored)",
        );
        throw new UnmappablePayloadError("Malformed JSON payload");
      }

      if (provider === "STRIPE") {
        return normalizeStripeEvent(json);
      } else {
        return normalizeRazorpayEvent(json);
      }
    },
  );

  // 3. Resolve Tenant ID
  const headerTenantId = headers["x-tenant-id"] as string | undefined;
  const payloadTenantId =
    (normalized.payload as any)?.tenant_id ||
    (normalized.payload as any)?.metadata?.tenant_id;

  let tenantId = queryTenantId || headerTenantId || payloadTenantId;

  if (!tenantId) {
    // Fallback: look up default/bootstrap tenant in database.
    // s-10 audit fix: provider webhooks carry no SIGNED tenant claim, so this
    // fallback is intentional — but it must be visible. Emit a WARN log +
    // webhook_tenant_fallback_total metric so operators can detect merchants
    // that never send tenant context (and notice unexpected cross-tenant
    // attribution), instead of failing silently.
    deps.logger.warn(
      { provider, correlationId },
      "Inbound webhook without tenant context; falling back to default tenant",
    );
    recordTenantFallback(provider);
    const [firstTenant] = await deps.repos.listTenants({ db: deps.db }, { limit: 1 });
    if (firstTenant) {
      tenantId = firstTenant.id;
    } else {
      const fallback = await deps.repos.createTenant(
        { db: deps.db },
        { name: "Default Tenant", slug: "default" },
      );
      tenantId = fallback.id;
    }
  }

  // 4. Persistence & Core Upserts within transaction
  const persistResult = await withSpan("webhook.persist", {}, async () => {
    return await deps.repos.withTransaction({ db: deps.db }, async (tx) => {
      const txCtx = { tx };
      const rawJson =
        typeof rawBody === "string"
          ? JSON.parse(rawBody)
          : JSON.parse(rawBody.toString("utf8"));

      // 4a. Idempotently insert into events table (the primary deduplication anchor)
      const insertResult = await deps.repos.insertEventIfNew(txCtx, {
        tenantId: tenantId!,
        source: provider,
        externalEventId: normalized.externalEventId,
        type: normalized.eventType,
        entityType: normalized.entityType,
        entityId: normalized.entityId,
        rawPayload: rawJson,
        payload: normalized.payload,
        correlationId,
        status: "RECEIVED",
        receivedAt: new Date(),
      });

      // If duplicate webhook delivery, skip core upserts to avoid unnecessary locks / writes
      if (insertResult.duplicate) {
        return { insertResult, coreResult: {} as UpsertCoreResult };
      }

      // 4b. Upsert financial core records for new events
      const coreResult = await upsertFinancialCoreRecords(txCtx, deps.repos, {
        tenantId: tenantId!,
        provider,
        projections: normalized.projections,
      });

      return { insertResult, coreResult };
    });
  });

  const { insertResult, coreResult } = persistResult;
  const durationMs = Date.now() - startTime;

  // 5. Handle Duplicate vs New Event
  if (insertResult.duplicate) {
    recordEventDuplicate(provider);
    recordWebhookDelivery(provider, "duplicate");
    recordWebhookLatency(provider, "duplicate", durationMs);

    deps.logger.info(
      {
        provider,
        external_event_id: normalized.externalEventId,
        type: normalized.eventType,
        status: "DUPLICATE",
        durationMs,
      },
      "Inbound webhook duplicate recognized and dropped",
    );

    return {
      status: "DUPLICATE",
      eventId: insertResult.event.id,
    };
  }

  // 6. New Event: Publish to EventBus (fire-and-forget, mark PROCESSED on successful ack)
  recordEventIngested(provider, normalized.eventType);
  recordWebhookDelivery(provider, "accepted");
  recordWebhookLatency(provider, "accepted", durationMs);

  const domainEvent: DomainEvent = {
    id: insertResult.event.id,
    type: normalized.eventType,
    occurred_at: normalized.occurredAt.toISOString(),
    source: provider,
    tenant_id: tenantId!,
    customer_id: coreResult.customerId || "none",
    entity_id: normalized.entityId || coreResult.paymentId || insertResult.event.id,
    entity_type: (normalized.entityType as EntityType) || "PAYMENT",
    payload: normalized.payload,
    correlation_id: correlationId,
    traceparent: input.traceparent,
  };

  // Fire-and-forget publication without blocking response
  deps.eventBus
    .publish(domainEvent, {
      topic: "revenue-events.v1",
      key: tenantId,
    })
    .then(async () => {
      await deps.repos.markEventProcessed(
        { db: deps.db },
        { tenantId: tenantId!, eventId: insertResult.event.id },
      );
    })
    .catch((err) => {
      // Event remains in RECEIVED state; s-11 dispatcher/replay handles recovery
      deps.logger.warn(
        {
          err: err.message,
          eventId: insertResult.event.id,
          provider,
        },
        "Asynchronous event bus publish failed; event remains in RECEIVED status",
      );
    });

  deps.logger.info(
    {
      provider,
      external_event_id: normalized.externalEventId,
      type: normalized.eventType,
      status: "ACCEPTED",
      durationMs,
    },
    "Inbound webhook processed and accepted",
  );

  return {
    status: "ACCEPTED",
    eventId: insertResult.event.id,
  };
}
