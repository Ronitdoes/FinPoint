import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { EVENT_TYPES, ENTITY_TYPES, type DomainEvent } from "@repo/domain";
import { TOPIC_MAIN } from "@repo/integrations";
import { recordEventIngested } from "@repo/observability";
import { sha256 } from "../../lib/crypto";
import {
  ForbiddenError,
  ValidationError,
  IdempotencyInFlightError,
  IdempotencyKeyReusedError,
} from "../../lib/errors";
import { ReplayService } from "./replay.service";

const inboundEventSchema = z
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
  .strict();

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

      await app.eventBus.publish(domainEvent, {
        topic: TOPIC_MAIN,
        key: body.tenant_id,
      });

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
