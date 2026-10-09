```ts
/**
 * Retry utility with configurable retryability predicate.
 * Retries only transient errors (network failures, timeouts, HTTP 5xx/429/408).
 * Deterministic errors (4xx validation, constraint violations) are not retried.
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  isRetryable?: (error: unknown, attempt: number) => boolean;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
  status?: number;
}

function isTransientHttpError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const err = error as { status?: number; code?: string | number };
  // HTTP 408 (Timeout), 429 (Too Many Requests), 5xx (Server Error)
  if (typeof err.status === "number") {
    return err.status === 408 || err.status === 429 || err.status >= 500;
  }
  // Network-level error codes
  if (err.code === "ENOTFOUND" || err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ECONNREFUSED") {
    return true;
  }
  return false;
}

function isTransientDbError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Postgres transport errors (connection reset, etc.)
  const err = error as { code?: string };
  // Transient DB transport errors
  if (err.code === "ECONNRESET" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
    return true;
  }
  // Constraint violations and other deterministic DB errors are NOT transient
  return false;
}

function isRpcValidationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const err = error as RpcError;
  // XRPC errors with non-5xx status codes are deterministic validation errors
  if (typeof err.status === "number" && err.status >= 400 && err.status < 500) {
    return true;
  }
  // Known deterministic ledger errors (e.g., -32600: startLedger must be within ledger range)
  if (typeof err.code === "number" && err.code === -32600) {
    return true;
  }
  return false;
}

export function getDefaultIsRetryable(): (error: unknown, attempt: number) => boolean {
  return (error: unknown, _attempt: number): boolean => {
    // RpcError with 4xx/validation codes: NOT retryable
    if (isRpcValidationError(error)) return false;
    // HTTP transient errors: retryable
    if (isTransientHttpError(error)) return true;
    // DB transient transport errors: retryable
    if (isTransientDbError(error)) return true;
    // Default: not retryable (deterministic errors)
    return false;
  };
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 4,
    baseDelayMs = 250,
    maxDelayMs = 4000,
    isRetryable = () => true,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt >= maxAttempts || !isRetryable(error, attempt)) {
        break;
      }

      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
