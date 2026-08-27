import {
  trace,
  context,
  SpanStatusCode,
  type Span,
  type Attributes,
} from "@opentelemetry/api";

/**
 * Standard span attribute keys per CONVENTIONS §11 & Spec 01 §20.
 */
export const RecoverySpanAttributes = {
  // Five core trace keys
  EVENT_ID: "recovery.event_id",
  CASE_ID: "recovery.case_id",
  WORKFLOW_ID: "recovery.workflow_id",
  DECISION_ID: "recovery.decision_id",
  ACTION_ID: "recovery.action_id",

  // Context keys
  TENANT_ID: "tenant.id",
  CUSTOMER_ID: "customer.id",

  // LLM keys
  LLM_MODEL: "llm.model",
  LLM_PROMPT_TOKENS: "llm.tokens.prompt",
  LLM_COMPLETION_TOKENS: "llm.tokens.completion",
  LLM_TOTAL_TOKENS: "llm.tokens.total",

  // Provider keys
  PROVIDER_NAME: "provider.name",
  PROVIDER_OPERATION: "provider.operation",

  // HTTP & Database keys
  HTTP_METHOD: "http.method",
  HTTP_ROUTE: "http.route",
  HTTP_STATUS_CODE: "http.status_code",
  DB_OPERATION: "db.operation",
  DB_TABLE: "db.table",
} as const;

export const SpanAttributes = RecoverySpanAttributes;

/**
 * Formats and sanitizes attributes for OpenTelemetry spans.
 */
function sanitizeSpanAttributes(
  attrs: Record<string, unknown> | undefined,
): Attributes {
  if (!attrs) return {};

  const sanitized: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    } else if (Array.isArray(value)) {
      sanitized[key] = value.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v)));
    } else {
      sanitized[key] = JSON.stringify(value);
    }
  }
  return sanitized;
}

/**
 * Executes an async function within an active OpenTelemetry span.
 *
 * Automatically:
 * - Creates an active child span under current context
 * - Attaches sanitized attributes
 * - Records errors and sets SpanStatusCode.ERROR if an exception is thrown
 * - Sets SpanStatusCode.OK on successful completion
 * - Ensures span.end() is called in a finally block
 *
 * @example
 * ```ts
 * const result = await withSpan("db.query", { "db.table": "recovery_cases" }, async (span) => {
 *   return await repo.findById(id);
 * });
 * ```
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer("ai-revenue-recovery");
  const sanitizedAttrs = sanitizeSpanAttributes(attrs);

  return tracer.startActiveSpan(name, { attributes: sanitizedAttrs }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) {
        span.recordException(error);
      } else {
        span.recordException(new Error(String(error)));
      }
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Synchronous variant of withSpan for deterministic / synchronous routines.
 */
export function withSpanSync<T>(
  name: string,
  attrs: Record<string, unknown> | undefined,
  fn: (span: Span) => T,
): T {
  const tracer = trace.getTracer("ai-revenue-recovery");
  const sanitizedAttrs = sanitizeSpanAttributes(attrs);

  return tracer.startActiveSpan(name, { attributes: sanitizedAttrs }, (span) => {
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) {
        span.recordException(error);
      } else {
        span.recordException(new Error(String(error)));
      }
      throw error;
    } finally {
      span.end();
    }
  });
}
