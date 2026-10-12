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
  /** Returns true when the error is worth retrying. Defaults to {@link defaultIsRetryable}. */
  isRetryable?: (error: unknown) => boolean;
  /** Injected for tests; defaults to a real sleep. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Default retry classifier: retry transient failures, not deterministic ones.
 *
 * Retried: network/transport errors, timeouts, HTTP 408/429/5xx, and anything
 * unrecognized (fail-open — a new transient failure mode should still get its
 * attempts rather than surfacing immediately).
 *
 * Not retried: HTTP 4xx validation errors, deterministic JSON-RPC errors
 * (-32600 invalid request, -32601 method not found, -32602 invalid params),
 * and Postgres constraint violations (the same payload will fail the same way
 * on every attempt).
 */
export function defaultIsRetryable(error: unknown): boolean {
  // Timeouts are always worth another attempt. Deno's AbortSignal.timeout()
  // surfaces as TimeoutError; older runtimes may use AbortError.
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);

  // Timeout by message (e.g. RpcError('... timed out ...') from stellar.ts).
  if (/timed out/i.test(message)) return true;

  // RpcError carries the HTTP status when the failure came from the transport.
  // 408/429/5xx are transient; other 4xx are validation errors that will not
  // change on retry.
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && Number.isInteger(status)) {
    if (status === 408 || status === 429 || (status >= 500 && status <= 599)) return true;
    if (status >= 400 && status < 500) return false;
  }

  // Deterministic JSON-RPC errors. -32600 (invalid request, e.g. a startLedger
  // outside the retention window), -32601 (method not found) and -32602
  // (invalid params) describe the request, not the network.
  if (/RPC error -3260[012]:/.test(message)) return false;

  // Postgres constraint violations: the same row will violate the same
  // constraint on every attempt. Matches the messages PostgREST surfaces,
  // which db.ts embeds verbatim in its wrapped errors.
  if (/violates (unique|foreign key|not-null|check) constraint/i.test(message)) return false;
  if (/duplicate key value/i.test(message)) return false;

  // Network/transport failures and anything unrecognized: retry.
  return true;
}

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
  const {
    attempts,
    baseDelayMs,
    maxDelayMs,
    isRetryable = defaultIsRetryable,
    sleep = defaultSleep,
  } = options;

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('withRetry requires attempts >= 1');
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === attempts) {
        throw error;
      }

      await sleep(backoffDelay(attempt, baseDelayMs, maxDelayMs));
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError;
}
