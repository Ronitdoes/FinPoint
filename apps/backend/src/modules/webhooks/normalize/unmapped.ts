import type { NormalizedEventResult } from "./types";

/**
 * Creates a normalized result for unmapped / unsupported webhook events.
 * Preserves raw event ID and stores payload without domain projections (Spec 01 §7, s-10 §Requirements 7).
 */
export function createUnmappedResult(
  externalEventId: string,
  rawType: string,
  rawPayload: Record<string, unknown>,
  reason?: string,
): NormalizedEventResult {
  return {
    externalEventId,
    eventType: "UNMAPPED",
    occurredAt: new Date(),
    payload: {
      raw_event_type: rawType,
      raw_payload: rawPayload,
      metadata: {
        reason: reason ?? `Unsupported provider event type: ${rawType}`,
        no_customer: true,
      },
    },
    projections: {},
    isUnmapped: true,
    unmappedReason: reason ?? `Unsupported provider event type: ${rawType}`,
  };
}
