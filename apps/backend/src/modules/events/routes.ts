import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  EVENT_TYPES,
  ENTITY_TYPES,
  PAYMENT_EVENT_TYPES,
  CHECKOUT_EVENT_TYPES,
  SUBSCRIPTION_EVENT_TYPES,
  INVOICE_EVENT_TYPES,
  type DomainEvent,
} from "@repo/domain";
import { TOPIC_MAIN, MAX_EVENT_PAYLOAD_BYTES } from "@repo/integrations";
import { recordEventIngested } from "@repo/observability";
import { sha256 } from "../../lib/crypto";
import {
  ForbiddenError,
  ValidationError,
  IdempotencyInFlightError,
  IdempotencyKeyReusedError,
} from "../../lib/errors";
import { ReplayService } from "./replay.service";

/**
 * s-11 gaps: per-type `payload` requirements for POST /events.
 *
 * The envelope previously accepted any JSON object as `payload`
 * (`z.record(z.unknown())`), so `payment.failed` without an amount or
 * `invoice.overdue` without an amount passed validation and failed
 * downstream instead. The rules below enumerate the minimal required
 * fields per event family, chosen so every real producer already sends
 * them (webhook normalizers in `modules/webhooks/normalize/*` always emit
 * `amount` for payment/invoice payloads and `cart_value` for checkout
 * payloads; the demo simulator emits camelCase `cartValue`).
 *
 * Decisions (required fields):
 * - payment.* → `amount` OR `amount_minor` (finite number, >= 0).
 *   `currency` is NOT required (existing callers omit it) but, when
 *   present, must be a non-empty string.
 * - invoice.* → `amount` OR `amount_minor`. `due_at`/`due_date` are NOT
 *   required (normalizers emit no due_at inside the payload envelope) but,
 *   when present, must be strings.
 * - checkout.* → one of `cart_total` (events.test.ts), `cart_value`
 *   (normalizers), `cartValue` (demo simulator), `amount`/`amount_minor`/`total`.
 * - subscription.* → one of `provider_subscription_id` / `subscription_id` / `status`.
 * - All other known types (customer.*, risk.*, case.*, human-task.*,
 *   UNMAPPED) keep envelope-only validation, except that known money/date
 *   keys are type-checked whenever they are present.
 */
const AMOUNT_LIKE_KEYS = ["amount", "amount_minor"] as const;
const CART_VALUE_KEYS = [
  "cart_total",
  "cart_value",
  "cartValue",
  "amount",
  "amount_minor",
  "total",
] as const;
const SUBSCRIPTION_ANCHOR_KEYS = [
  "provider_subscription_id",
  "subscription_id",
  "status",
] as const;
const MONEY_KEYS = [
  "amount",
  "amount_minor",
  "cart_total",
  "cart_value",
  "cartValue",
  "total",
] as const;

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  );
}

function validateEventPayload(
  type: string,
  payload: Record<string, unknown>,
  ctx: z.RefinementCtx,
): void {
  // 1. Generic known-key type checks (apply to every event type).
  for (const key of MONEY_KEYS) {
    if (
      Object.hasOwn(payload, key) &&
      !isFiniteNonNegativeNumber(payload[key])
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", key],
        message: `payload.${key} must be a finite number >= 0 when present`,
      });
    }
  }
  if (
    Object.hasOwn(payload, "currency") &&
    (typeof payload["currency"] !== "string" ||
      payload["currency"].length === 0)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", "currency"],
      message: "payload.currency must be a non-empty string when present",
    });
  }
  for (const key of ["due_at", "due_date"] as const) {
    if (
      Object.hasOwn(payload, key) &&
      typeof payload[key] !== "string"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", key],
        message: `payload.${key} must be a string when present`,
      });
    }
  }

  // 2. Per-family presence requirements (missing key => 422 VALIDATION).
  const requireOneOf = (keys: readonly string[], message: string): void => {
    const satisfied = keys.some(
      (key) =>
        Object.hasOwn(payload, key) &&
        isFiniteNonNegativeNumber(payload[key]),
    );
    if (!satisfied) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message,
      });
    }
  };

  if ((PAYMENT_EVENT_TYPES as readonly string[]).includes(type)) {
    requireOneOf(
      AMOUNT_LIKE_KEYS,
      "payment events require payload.amount or payload.amount_minor (finite number >= 0)",
    );
  } else if ((INVOICE_EVENT_TYPES as readonly string[]).includes(type)) {
    requireOneOf(
      AMOUNT_LIKE_KEYS,
      "invoice events require payload.amount or payload.amount_minor (finite number >= 0)",
    );
  } else if ((CHECKOUT_EVENT_TYPES as readonly string[]).includes(type)) {
    requireOneOf(
      CART_VALUE_KEYS,
      "checkout events require a cart value (payload.cart_total, payload.cart_value, payload.cartValue, payload.amount, payload.amount_minor, or payload.total as a finite number >= 0)",
    );
  } else if (
    (SUBSCRIPTION_EVENT_TYPES as readonly string[]).includes(type)
  ) {
    const hasAnchor = SUBSCRIPTION_ANCHOR_KEYS.some((key) => {
      if (!Object.hasOwn(payload, key)) return false;
      const value = payload[key];
      return typeof value === "string"
        ? value.length > 0
        : isFiniteNonNegativeNumber(value);
    });
    if (!hasAnchor) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload"],
        message:
          "subscription events require payload.provider_subscription_id, payload.subscription_id, or payload.status",
      });
    }
  }
}

export const inboundEventSchema = z
  .object({
    type: z.enum(EVENT_TYPES),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    source: z.string().min(1).default("INTERNAL"),
    tenant_id: z.string().min(1),
    customer_id: z.string().min(1).optional(),
    entity_type: z.enum(ENTITY_TYPES).default("CHECKOUT"),
    entity_id: z.string().min(1),
    payload: z.record(z.unknown()).default({}),
    correlation_id: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    validateEventPayload(data.type, data.payload, ctx);
  });

const replaySchema = z
  .object({
    eventId: z.string().min(1).optional(),
    filter: z
      .object({
        tenant_id: z.string().min(1).optional(),
        type: z.string().min(1).optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        status: z.string().min(1).optional(),
      })
      .optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100).optional(),
  })
  .strict()
  .refine((data) => data.eventId || data.filter, {
    message: "Either eventId or filter must be provided",
  });

/**
 * Maps EventBus publish failures to domain errors (s-11 MED fix).
 *
 * envelope-codec enforces the 256KB cap inside `encodeDomainEvent` and throws
 * a generic `Error("Event payload exceeds maximum allowed size ...")`, which
 * would otherwise surface as a 500 INTERNAL. Oversized envelopes are a client
 * error, so they map to 422 VALIDATION with a clear message. All other errors
 * (including existing ValidationErrors) pass through unchanged, preserving
 * the awaited fire-and-forget publish behavior.
 */
export function mapEventPublishError(err: unknown): unknown {
  if (err instanceof ValidationError) {
    return err;
  }
  const message = String((err as any)?.message ?? "");
  if (message.includes("exceeds maximum allowed size")) {
    return new ValidationError(
      `Event encoded payload exceeds 256KB limit (${MAX_EVENT_PAYLOAD_BYTES} bytes); reduce payload size or split the event`,
      { maxBytes: MAX_EVENT_PAYLOAD_BYTES },
    );
  }
  return err;
}

export const eventsRoutes: FastifyPluginAsync = async (app) => {
  const replayService = new ReplayService(app);

  /**
   * POST /events — Authenticated internal event ingestion (s-11 §POST /events contract)
   */
  app.post(
    "",
    {
      preHandler: [app.requireAuth, app.requireScope("events:write")],
      config: {
        rateLimit: {
          max: 60,
          timeWindow: 60000, // 60 requests/min default
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // 1. Validate body schema
      const parseResult = inboundEventSchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new ValidationError("Invalid event payload structure", {
          issues: parseResult.error.issues,
        });
      }

      const body = parseResult.data;

      // 2. Tenant isolation check
      const tenantScope = app.getTenantScope(request);
      if (body.tenant_id !== tenantScope.tenantId) {
        throw new ForbiddenError(
          "Cross-tenant event ingestion is not permitted",
        );
      }

      // 3. Optional Idempotency-Key handling (24h TTL)
      const idempotencyKey = request.headers["idempotency-key"] as
        | string
        | undefined;
      const requestHash = sha256(JSON.stringify(request.body));

      if (idempotencyKey) {
        const acquireResult = await app.repos.tryAcquire(
          { db: app.db },
          {
            key: idempotencyKey,
            requestHash,
            ttlSeconds: 86400, // 24 hours
          },
        );

        if (acquireResult === "COMPLETED_DIFFERENT") {
          throw new IdempotencyKeyReusedError(
            "Idempotency-Key was previously used with a different payload",
          );
        }

        if (acquireResult === "IN_FLIGHT") {
          const snapshot = await app.repos.getResponseSnapshot(
            { db: app.db },
            { key: idempotencyKey },
          );
          if (snapshot) {
            return reply.status(202).send(snapshot);
          }
          throw new IdempotencyInFlightError();
        }
      }

      // 4. Ingest into database (source = 'INTERNAL')
      const correlationId = body.correlation_id ?? randomUUID();

      // Safely resolve DB customer foreign key (UUID) if customer exists
      let dbCustomerId: string | null = null;
      if (body.customer_id) {
        const isUuid =
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            body.customer_id,
          );
        if (isUuid) {
          const cust = await app.repos.findCustomerById(
            { db: app.db },
            { tenantId: body.tenant_id, customerId: body.customer_id },
          );
          if (cust) {
            dbCustomerId = cust.id;
          }
        }
      }

      const insertResult = await app.repos.insertEventIfNew(
        { db: app.db },
        {
          tenantId: body.tenant_id,
          source: "INTERNAL",
          type: body.type,
          customerId: dbCustomerId,
          entityType: body.entity_type,
          entityId: body.entity_id,
          rawPayload: body.payload,
          payload: body.payload,
          correlationId,
          status: "RECEIVED",
          receivedAt: body.occurred_at ? new Date(body.occurred_at) : new Date(),
        },
      );

      const eventRow = insertResult.event;

      // 5. Asynchronously publish to EventBus
      const domainEvent: DomainEvent = {
        id: eventRow.id,
        type: body.type,
        occurred_at: body.occurred_at ?? new Date().toISOString(),
        source: "INTERNAL",
        tenant_id: body.tenant_id,
        customer_id: body.customer_id ?? dbCustomerId ?? "cus_unspecified",
        entity_id: body.entity_id,
        entity_type: body.entity_type,
        payload: body.payload,
        correlation_id: correlationId,
        traceparent: request.headers["traceparent"] as string | undefined,
      };

      // 5. Publish to EventBus (awaited — fire-and-forget behavior unchanged).
      // Size errors map to 422 VALIDATION via mapEventPublishError; all other
      // errors propagate untouched.
      try {
        await app.eventBus.publish(domainEvent, {
          topic: TOPIC_MAIN,
          key: body.tenant_id,
        });
      } catch (err: unknown) {
        throw mapEventPublishError(err);
      }

      // 6. Mark as PROCESSED in database
      await app.repos.markEventProcessed(
        { db: app.db },
        { tenantId: body.tenant_id, eventId: eventRow.id },
      );

      const responsePayload = { eventId: eventRow.id };

      // 7. Complete idempotency lease if applicable
      if (idempotencyKey) {
        await app.repos.complete(
          { db: app.db },
          {
            key: idempotencyKey,
            responseSnapshot: responsePayload,
            ttlSeconds: 86400,
          },
        );
      }

      recordEventIngested("INTERNAL", body.type);

      return reply.status(202).send(responsePayload);
    },
  );

  /**
   * POST /events/replay — Re-publish stored event(s) by id or filter (s-11 §POST /events/replay contract)
   */
  app.post(
    "/replay",
    {
      preHandler: [
        app.requireAuth,
        app.requireRole("OPERATIONS", "FINANCE", "ADMIN"),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parseResult = replaySchema.safeParse(request.body);
      if (!parseResult.success) {
        throw new ValidationError("Invalid replay request parameters", {
          issues: parseResult.error.issues,
        });
      }

      const tenantScope = app.getTenantScope(request);
      const callerUserId = request.auth?.userId;

      const result = await replayService.replayEvents(
        tenantScope.tenantId,
        callerUserId,
        parseResult.data,
      );

      return reply.status(202).send(result);
    },
  );
};
