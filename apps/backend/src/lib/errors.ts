/**
 * Canonical Domain Errors & Error Envelope for AI-Revenue-Recovery Backend.
 *
 * Implements the standard error hierarchy and HTTP mapping from ADR-002 and CONVENTIONS §6:
 * - VALIDATION → 422 { error: { code: 'VALIDATION', details: ... } }
 * - UNAUTHENTICATED → 401
 * - FORBIDDEN → 403
 * - NOT_FOUND → 404
 * - CONFLICT / DUPLICATE_* → 409
 * - IDEMPOTENCY_IN_FLIGHT → 409 (with Retry-After header)
 * - RATE_LIMITED → 429 (with Retry-After header)
 * - INTERNAL (unhandled) → 500 (generic safe message, no stack leak)
 */

export const DomainErrorCodes = {
  VALIDATION: "VALIDATION",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  IDEMPOTENCY_IN_FLIGHT: "IDEMPOTENCY_IN_FLIGHT",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  RATE_LIMITED: "RATE_LIMITED",
  TENANT_CONTEXT_MISSING: "TENANT_CONTEXT_MISSING",
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  UNMAPPABLE_PAYLOAD: "UNMAPPABLE_PAYLOAD",
  NOT_ACCEPTABLE: "NOT_ACCEPTABLE",
  INTERNAL: "INTERNAL",
} as const;

export type DomainErrorCode =
  (typeof DomainErrorCodes)[keyof typeof DomainErrorCodes] | (string & {});

export interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: unknown;
  };
}

export class DomainError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details: unknown;
  public readonly headers?: Record<string, string>;

  constructor(
    message: string,
    code: string = DomainErrorCodes.INTERNAL,
    statusCode: number = 500,
    details: unknown = {},
    headers?: Record<string, string>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.headers = headers;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string = "Validation failed", details: unknown = {}) {
    super(message, DomainErrorCodes.VALIDATION, 422, details);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message: string = "Authentication required", details: unknown = {}) {
    super(message, DomainErrorCodes.UNAUTHENTICATED, 401, details);
  }
}

export class InvalidCredentialsError extends DomainError {
  constructor(message: string = "Invalid email or password", details: unknown = {}) {
    super(message, DomainErrorCodes.INVALID_CREDENTIALS, 401, details);
  }
}

export class TenantContextMissingError extends DomainError {
  constructor(message: string = "Tenant context is mandatory for this request", details: unknown = {}) {
    super(message, DomainErrorCodes.TENANT_CONTEXT_MISSING, 400, details);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message: string = "Access forbidden", details: unknown = {}) {
    super(message, DomainErrorCodes.FORBIDDEN, 403, details);
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string = "Resource not found", details: unknown = {}) {
    super(message, DomainErrorCodes.NOT_FOUND, 404, details);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string = "Resource conflict", code: string = DomainErrorCodes.CONFLICT, details: unknown = {}) {
    super(message, code, 409, details);
  }
}

export class IdempotencyInFlightError extends DomainError {
  constructor(
    message: string = "Request with this idempotency key is currently being processed",
    retryAfterSeconds: number = 2,
    details: unknown = {},
  ) {
    super(message, DomainErrorCodes.IDEMPOTENCY_IN_FLIGHT, 409, details, {
      "Retry-After": String(retryAfterSeconds),
    });
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  constructor(
    message: string = "Idempotency key was already used with a different request payload",
    details: unknown = {},
  ) {
    super(message, DomainErrorCodes.IDEMPOTENCY_KEY_REUSED, 409, details);
  }
}

export class RateLimitedError extends DomainError {
  constructor(
    message: string = "Rate limit exceeded",
    retryAfterSeconds: number = 60,
    details: unknown = {},
  ) {
    super(message, DomainErrorCodes.RATE_LIMITED, 429, details, {
      "Retry-After": String(retryAfterSeconds),
    });
  }
}

export class InvalidSignatureError extends DomainError {
  constructor(message: string = "Invalid webhook signature", details: unknown = {}) {
    super(message, DomainErrorCodes.INVALID_SIGNATURE, 401, details);
  }
}

export class UnmappablePayloadError extends DomainError {
  constructor(message: string = "Payload cannot be mapped or parsed", details: unknown = {}) {
    super(message, DomainErrorCodes.UNMAPPABLE_PAYLOAD, 400, details);
  }
}

export class NotAcceptableError extends DomainError {
  constructor(message: string = "Content-Type must be application/json", details: unknown = {}) {
    super(message, DomainErrorCodes.NOT_ACCEPTABLE, 406, details);
  }
}

export class InternalError extends DomainError {
  constructor(message: string = "An internal server error occurred", details: unknown = {}) {
    super(message, DomainErrorCodes.INTERNAL, 500, details);
  }
}

