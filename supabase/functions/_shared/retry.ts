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

/** Retry transport/availability failures, never unknown application failures. */
export function isRetryableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const value = error as { name?: unknown; message?: unknown; status?: unknown; code?: unknown };
  const code = typeof value.code === 'string' ? value.code : '';
  // PostgreSQL integrity and input errors are deterministic, even if their
  // messages happen to contain words such as "timeout".
  if (/^(22|23)/.test(code)) return false;
  if (/^08/.test(code) || ['40001', '40P01', '53300', '57P01', '57P02', '57P03'].includes(code)) {
    return true;
  }
  if (typeof value.status === 'number') {
    return value.status === 408 || value.status === 429 ||
      (value.status >= 500 && value.status < 600);
  }
  if (value.name === 'TimeoutError') return true;
  const message = typeof value.message === 'string' ? value.message : '';
  const rpcCode = /RPC error (-?\d+)/.exec(message)?.[1];
  if (rpcCode !== undefined) {
    const code = Number(rpcCode);
    return code <= -32000 && code >= -32099;
  }
  return /connection (refused|reset|terminated|closed)|econnreset|etimedout|econnrefused|socket hang up|network connection was lost|too many clients|terminating connection due to|could not connect|fetch failed|failed to fetch|error sending request|dns error|timed out|timeout expired|serialization failure|deadlock detected/i
    .test(message);
}
