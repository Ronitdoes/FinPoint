import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DomainEvent, EventType } from "@repo/domain";
import { TOPIC_MAIN } from "@repo/integrations";
import { NotFoundError, ValidationError } from "../../lib/errors";

export interface ReplayFilter {
  tenant_id?: string;
  type?: EventType | string;
  from?: string;
  to?: string;
  status?: string;
}

export interface ReplayRequestInput {
  eventId?: string;
  filter?: ReplayFilter;
  limit?: number;
}

export interface ReplayResult {
  queued: number;
  replayIds: string[];
}

export class ReplayService {
  constructor(private readonly fastify: FastifyInstance) {}

  async replayEvents(
    callerTenantId: string,
    callerUserId: string | undefined,
    input: ReplayRequestInput,
  ): Promise<ReplayResult> {
    const { db, repos, eventBus } = this.fastify;

    if (!input.eventId && !input.filter) {
      throw new ValidationError("Must specify either eventId or filter in replay request");
    }

    let originalEvents: any[] = [];

    if (input.eventId) {
      // Find single event by ID
      const single = await repos.findEventById(
        { db },
        { tenantId: callerTenantId, eventId: input.eventId },
      );
      if (!single) {
        throw new NotFoundError(`Event with ID '${input.eventId}' not found`);
      }
      originalEvents = [single];
    } else if (input.filter) {
      // Find events by filter
      const targetTenantId = input.filter.tenant_id ?? callerTenantId;

      originalEvents = await repos.findEventsByFilter(
        { db },
        {
          tenantId: targetTenantId,
          type: input.filter.type as any,
          status: input.filter.status as any,
          from: input.filter.from ? new Date(input.filter.from) : undefined,
          to: input.filter.to ? new Date(input.filter.to) : undefined,
          limit: input.limit ?? 100,
        },
      );
    }

    const replayIds: string[] = [];

    for (const orig of originalEvents) {
      const newCorrelationId = randomUUID();
      const replayedPayload = {
        ...(orig.payload as Record<string, unknown>),
        replayed_from: orig.id,
      };

      // 1. Insert new event referencing original (replayed_from inside payload JSONB per s-11)
      const insertResult = await repos.insertEventIfNew(
        { db },
        {
          tenantId: orig.tenantId,
          source: orig.source,
          type: orig.type,
          customerId: orig.customerId,
          entityType: orig.entityType,
          entityId: orig.entityId,
          rawPayload: orig.rawPayload as Record<string, unknown>,
          payload: replayedPayload,
          correlationId: newCorrelationId,
          status: "RECEIVED",
          receivedAt: new Date(),
        },
      );

      const newEventRow = insertResult.event;
      replayIds.push(newEventRow.id);

      // 2. Publish copy to EventBus with fresh correlation ID and metadata
      const domainEvent: DomainEvent = {
        id: newEventRow.id,
        type: orig.type,
        occurred_at: new Date().toISOString(),
        source: orig.source,
        tenant_id: orig.tenantId,
        customer_id: orig.customerId ?? "cus_unspecified",
        entity_id: orig.entityId ?? "ent_unspecified",
        entity_type: (orig.entityType as any) ?? "PAYMENT",
        payload: replayedPayload,
        correlation_id: newCorrelationId,
        traceparent: undefined,
      };

      await eventBus.publish(domainEvent, {
        topic: TOPIC_MAIN,
        key: orig.tenantId,
        headers: {
          "x-correlation-id": newCorrelationId,
          "x-replayed-from": orig.id,
        },
      });

      // 3. Mark new event row as PROCESSED upon bus ack
      await repos.markEventProcessed(
        { db },
        { tenantId: orig.tenantId, eventId: newEventRow.id },
      );
    }

    // 4. Record Audit Log entry (actor=USER, event='events.replayed', metadata={ filter|eventId, queued })
    await repos.recordAuditLog(
      { db },
      {
        tenantId: callerTenantId,
        actorType: "USER",
        actorId: callerUserId ?? "system",
        event: "events.replayed",
        metadata: {
          eventId: input.eventId,
          filter: input.filter,
          queued: replayIds.length,
          replayIds,
        },
        correlationId: randomUUID(),
      },
    );

    return {
      queued: replayIds.length,
      replayIds,
    };
  }
}
