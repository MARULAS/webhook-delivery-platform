/**
 * Shared application error model (ARCHITECTURE.md section 22).
 *
 * Route and module code should throw one of the concrete subclasses below
 * instead of a plain Error. The single Fastify error handler
 * (see error-handler.ts) maps each subclass to its HTTP status code and the
 * shared response shape. Do not add further subclasses without a concrete
 * need already present in the specification's error categories.
 */

export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  readonly details?: unknown;

  protected constructor(message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = "VALIDATION_ERROR";

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = "NOT_FOUND";

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = "CONFLICT";

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

export class InvalidStateError extends AppError {
  readonly statusCode = 409;
  readonly code = "INVALID_STATE";

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}

export class SecurityError extends AppError {
  readonly statusCode = 400;
  readonly code = "SECURITY_ERROR";

  constructor(message: string, details?: unknown) {
    super(message, details);
  }
}
