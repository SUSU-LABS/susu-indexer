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

/**
 * Classifies an error as worth retrying.
 *
 * Retrying a deterministic failure — a validation error, a Postgres
 * constraint violation, a JSON-RPC `-32600` — cannot make it succeed: it
 * burns the attempt budget and ~4s of backoff, spends RPC quota, and buries
 * the real cause under a stack of identical failures. Only errors whose next
 * occurrence might differ are retried:
 *
 * - network-level failures (fetch could not reach the peer at all);
 * - HTTP 408 / 429 / 5xx, where the server asked for patience or failed
 *   transiently;
 * - JSON-RPC *server* error codes (-32000..-32099), the range the spec
 *   reserves for server-side conditions — as opposed to -326xx
 *   (parse/invalid/method-not-found) and -327xx (parse error), which are
 *   the request's own fault and will fail identically on every attempt;
 * - database messages that read as transport or availability problems
 *   (connection reset, timeout, "terminating connection", "too many
 *   clients"), as opposed to constraint/integrity violations (duplicate
 *   key, foreign key, check constraint) which are deterministic.
 *
 * Anything unrecognised — including non-Error rejections — is retried: an
 * unknown transport failure should not be classified as permanent by
 * accident. Callers that know better (a deterministic client bug) can pass a
 * narrower `isRetryable` to {@linkcode withRetry}.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === 'TypeError') {
      // fetch-level failures: "error sending request for url", "dns error",
      // "connection refused", "network connection was lost".
      return true;
    }

    const withStatus = error as Error & { status?: unknown };
    if (typeof withStatus.status === 'number') {
      return (
        withStatus.status === 408 ||
        withStatus.status === 429 ||
        withStatus.status >= 500
      );
    }

    const rpcCode = /RPC error (-?\d+)/.exec(error.message)?.[1];
    if (rpcCode !== undefined) {
      const code = Number(rpcCode);
      return code <= -32000 && code >= -32099;
    }

    if (
      /connection (refused|reset|terminated|closed)|econnreset|etimedout|econnrefused|socket hang up|network connection was lost|too many clients|terminating connection due to|still in use|could not connect/i
        .test(error.message)
    ) {
      return true;
    }

    // Constraint violations, bad input, unrecognised application errors:
    // deterministic. They will fail the same way on every attempt.
    return false;
  }

  return true;
}

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
