// Shared error conventions (spec §11).
//
// One envelope shape for every non-2xx response:
//   { "error": { "code": "...", "message": "...", "details": {} } }
//
// Two rules carried over from Project 1, both learned the same way — an error
// path is the easiest place to leak something you did not mean to:
//
//   1. `message` is safe to show a user. Provider names, env-var names, file
//      paths, and stack traces never appear in it. Operator-facing detail goes
//      to the logs, which is where it belongs.
//   2. A validator collects *every* problem it finds, not just the first, so
//      one round-trip tells the caller everything that is wrong.

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'APPROVAL_REQUIRED',
  'INVALID_STATE',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = Object.freeze({
  VALIDATION_ERROR: 400,
  // M5-A/B. 401 means "not signed in"; 403 means "signed in, but this request
  // is not one you may make" — which is where a failed CSRF check lands.
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  APPROVAL_REQUIRED: 403,
  INVALID_STATE: 409,
  PROVIDER_UNAVAILABLE: 502,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
});

export type ErrorEnvelope = {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;
  /**
   * Operator-facing context. Logged, never serialised into a response — this
   * is where a provider name or a failing SQL statement is allowed to go.
   */
  readonly internal: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; internal?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options.details ?? {};
    this.internal = options.internal;
  }

  toEnvelope(): ErrorEnvelope {
    const error: ErrorEnvelope['error'] = { code: this.code, message: this.message };
    if (Object.keys(this.details).length > 0) error.details = this.details;
    return { error };
  }
}

export class ValidationError extends AppError {
  readonly problems: readonly string[];

  constructor(problems: readonly string[], message = 'The request could not be processed as sent.') {
    super('VALIDATION_ERROR', message, { details: { problems: [...problems] } });
    this.name = 'ValidationError';
    this.problems = [...problems];
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} was not found.`);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFLICT', message, details ? { details } : {});
    this.name = 'ConflictError';
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/**
 * Converts anything thrown anywhere into a response envelope.
 *
 * An unrecognised error becomes a generic INTERNAL_ERROR with a fixed message.
 * That is deliberate: an unexpected error's own message was written for a
 * developer, not a user, and may quote a connection string, a file path, or a
 * row of customer data. The real message goes to `internal` for the caller to
 * log instead.
 */
export function toErrorEnvelope(err: unknown): { status: number; body: ErrorEnvelope; internal: string } {
  if (isAppError(err)) {
    return {
      status: err.status,
      body: err.toEnvelope(),
      internal: err.internal ?? `${err.name}: ${err.message}`,
    };
  }

  const internal = err instanceof Error ? `${err.name}: ${err.message}` : `Non-error thrown: ${String(err)}`;
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } },
    internal,
  };
}
