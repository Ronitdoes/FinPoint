/**
 * Custom error thrown when an action with an identical idempotency key is submitted.
 */
export class DuplicateActionError extends Error {
  readonly code = "DUPLICATE_ACTION";

  constructor(message = "A recovery action with this idempotency key already exists") {
    super(message);
    this.name = "DuplicateActionError";
  }
}

/**
 * Custom error thrown when a message with an identical idempotency key is submitted.
 */
export class DuplicateMessageError extends Error {
  readonly code = "DUPLICATE_MESSAGE";

  constructor(message = "A message with this idempotency key already exists") {
    super(message);
    this.name = "DuplicateMessageError";
  }
}

/**
 * Custom error thrown when tenant context is missing.
 */
export class TenantContextMissingError extends Error {
  readonly code = "TENANT_CONTEXT_MISSING";

  constructor(message = "Tenant context is required for this operation") {
    super(message);
    this.name = "TenantContextMissingError";
  }
}

/**
 * Custom error thrown when a requested entity is not found.
 */
export class EntityNotFoundError extends Error {
  readonly code = "ENTITY_NOT_FOUND";

  constructor(entityName: string, id: string) {
    super(`${entityName} with ID '${id}' was not found`);
    this.name = "EntityNotFoundError";
  }
}

/**
 * Helper to identify PostgreSQL unique constraint violation (SQLSTATE 23505).
 *
 * Drizzle-orm wraps the driver error in `DrizzleQueryError` whose own
 * `message` is a generic "Failed query: ..." string — the SQLSTATE lives on
 * `error.cause` (the underlying `postgres-js` PostgresError). Check the
 * whole `cause` chain so callers see 23505 regardless of wrapping depth.
 */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  // Walk at most 5 levels: DrizzleQueryError -> PostgresError -> ... (+ tx wrappers).
  for (let depth = 0; depth < 5; depth++) {
    if (!current || typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === "23505") return true;
    const next = (current as { cause?: unknown }).cause;
    if (!next || typeof next !== "object") return false;
    current = next;
  }
  return false;
}

/**
 * Concatenates an error's message with its `cause` chain messages.
 * Useful because Drizzle's `Failed query: ...` wrapper hides the underlying
 * PostgreSQL message (e.g. the append-only trigger text) on `.cause`.
 */
export function getCombinedErrorMessage(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object" && current !== null) {
      const msg = (current as { message?: unknown }).message;
      if (typeof msg === "string" && msg.length > 0) parts.push(msg);
      const next = (current as { cause?: unknown }).cause;
      if (!next || (typeof next !== "object" && typeof next !== "string")) break;
      if (typeof next === "string") {
        parts.push(next);
        break;
      }
      current = next;
    } else if (typeof current === "string") {
      parts.push(current);
      break;
    } else {
      break;
    }
  }
  return parts.join("\nCaused by: ");
}

/**
 * True when the error chain contains a PostgreSQL error with the given SQLSTATE.
 */
export function hasPgErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (!current || typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === code) return true;
    const next = (current as { cause?: unknown }).cause;
    if (!next || typeof next !== "object") return false;
    current = next;
  }
  return false;
}
