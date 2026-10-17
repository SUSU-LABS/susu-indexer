/**
 * Retry with exponential backoff.
 *
 * The indexer depends on an external RPC and a database, both of which can fail
 * transiently. Retries are bounded so a scheduled run cannot hang until the
 * platform kills it, and the checkpoint is unaffected by a failed attempt —
 * a partially processed range is simply retried on the next run.
 */

export type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Returns true when the error is worth retrying. Defaults to always retry. */
  isRetryable?: (error: unknown) => boolean;
  /** Injected for tests; defaults to a real sleep. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Computes the backoff delay for a given attempt (1-based), capped at maxDelayMs. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, maxDelayMs);
}

/**
 * Runs `operation`, retrying with exponential backoff until it succeeds or the
 * attempt budget is exhausted. The last error is rethrown.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { attempts, baseDelayMs, maxDelayMs, isRetryable, sleep = defaultSleep } = options;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('withRetry requires attempts >= 1');
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      const retryable = isRetryable === undefined ? true : isRetryable(error);
      if (!retryable || attempt === attempts) {
        throw error;
      }

      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError;
}

/**
 * Classifies an error as transient (retryable) or deterministic (non-retryable).
 *
 * Deterministic errors (such as JSON-RPC -32600 startLedger out-of-range, HTTP 4xx,
 * and PostgreSQL constraint violations) fail immediately on attempt 1 without
 * burning backoff delay or RPC quota.
 */
export function isRetryableError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const err = error as {
    status?: number;
    message?: string;
  };

  const status = typeof err.status === 'number' ? err.status : undefined;
  if (status !== undefined) {
    // Transient HTTP codes
    if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
      return true;
    }
    // Client error HTTP codes (400, 401, 403, 404, etc.)
    if (status >= 400 && status < 500) {
      return false;
    }
    // Deterministic JSON-RPC codes: Parse error, Invalid Request, Method not found, Invalid params
    if (status === -32700 || status === -32600 || status === -32601 || status === -32602) {
      return false;
    }
    // JSON-RPC server-defined implementation errors (-32000 to -32099) or -32603 internal error
    if ((status <= -32000 && status >= -32099) || status === -32603) {
      return true;
    }
  }

  const message = typeof err.message === 'string' ? err.message : String(error);

  // Deterministic Postgres constraint violations
  if (
    message.includes('violates unique constraint') ||
    message.includes('violates foreign key constraint') ||
    message.includes('violates check constraint') ||
    message.includes('violates not-null constraint') ||
    message.includes('duplicate key value')
  ) {
    return false;
  }

  // Network / fetch / timeout errors are transient
  return true;
}
