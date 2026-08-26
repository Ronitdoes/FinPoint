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
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return (error as { code?: string }).code === "23505";
}
