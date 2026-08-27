import { domainEventSchema, type DomainEvent } from "@repo/domain";

export const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024; // 256KB strict limit (Spec 01 §6, s-11 §Security)

export type DecodeResult =
  | { success: true; event: DomainEvent }
  | {
      success: false;
      error: Error;
      isPoison: true;
      rawPayload?: unknown;
    };

/**
 * Serializes a validated DomainEvent to a JSON string.
 */
export function encodeDomainEvent(event: DomainEvent): string {
  // Validate schema before serializing
  const validated = domainEventSchema.parse(event);
  const serialized = JSON.stringify(validated);

  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error(
      `Event payload exceeds maximum allowed size of ${MAX_EVENT_PAYLOAD_BYTES} bytes`,
    );
  }

  return serialized;
}

/**
 * Decodes and validates raw bytes or string into a DomainEvent.
 * Detects corrupted JSON or schema-invalid envelopes as poison pills.
 */
export function decodeDomainEvent(raw: unknown): DecodeResult {
  if (raw === null || raw === undefined) {
    return {
      success: false,
      error: new Error("Empty or null event payload"),
      isPoison: true,
      rawPayload: raw,
    };
  }

  let text: string;
  if (typeof raw === "string") {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString("utf8");
  } else if (typeof raw === "object") {
    text = JSON.stringify(raw);
  } else {
    return {
      success: false,
      error: new Error(`Unsupported raw payload type: ${typeof raw}`),
      isPoison: true,
      rawPayload: raw,
    };
  }

  // Enforce max size check
  if (Buffer.byteLength(text, "utf8") > MAX_EVENT_PAYLOAD_BYTES) {
    return {
      success: false,
      error: new Error(
        `Event payload of ${Buffer.byteLength(text, "utf8")} bytes exceeds maximum allowed size of ${MAX_EVENT_PAYLOAD_BYTES} bytes`,
      ),
      isPoison: true,
      rawPayload: text,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (err: any) {
    return {
      success: false,
      error: new Error(`Malformed JSON payload: ${err.message}`),
      isPoison: true,
      rawPayload: text,
    };
  }

  const parseResult = domainEventSchema.safeParse(parsedJson);
  if (!parseResult.success) {
    return {
      success: false,
      error: new Error(
        `Schema validation failure: ${parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ")}`,
      ),
      isPoison: true,
      rawPayload: parsedJson,
    };
  }

  return {
    success: true,
    event: parseResult.data,
  };
}
