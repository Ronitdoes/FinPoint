import { z } from "zod";

import { EVENT_TYPES } from "../enums/event-type";

export const ENTITY_TYPES = [
  "CUSTOMER",
  "PAYMENT",
  "SUBSCRIPTION",
  "CHECKOUT",
  "INVOICE",
  // s-21 audit fix: human-task SLA breach events are about the HUMAN_TASK entity
  // (entity_id = human_tasks.id); CASE is included for case-scoped task events.
  "HUMAN_TASK",
  "CASE",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const domainEventSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(EVENT_TYPES),
    occurred_at: z.string().datetime({ offset: true }),
    source: z.string().min(1),
    tenant_id: z.string().min(1),
    customer_id: z.string().min(1),
    entity_id: z.string().min(1),
    entity_type: z.enum(ENTITY_TYPES),
    payload: z.record(z.unknown()),
    correlation_id: z.string().min(1),
    traceparent: z.string().min(1).optional(),
  })
  .strict();

export type DomainEvent = z.infer<typeof domainEventSchema>;

export function parseDomainEvent(input: unknown): DomainEvent {
  return domainEventSchema.parse(input);
}
