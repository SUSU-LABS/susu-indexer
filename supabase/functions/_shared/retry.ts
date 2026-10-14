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

/** HTTP statuses that say "the server had a blip", not "your request is wrong". */
const RETRYABLE_HTTP_STATUS = new Set([408, 429]);

/**
 * JSON-RPC codes that reject the request itself.
 *
 * Both are produced by the shape of the call, so replaying an identical body
 * cannot change the outcome — see the `-32600: startLedger must be within the
 * ledger range` case documented in RUNBOOK.md.
 */
const DETERMINISTIC_JSON_RPC_CODES = new Set([-32600, -32602]);

/** Wording that marks a rejection as deterministic rather than a transient blip. */
const DETERMINISTIC_MARKERS = [
  'must be',
  'invalid',
  'violates',
  'constraint',
  'not found',
  'unauthorized',
  'forbidden',
];

/** Reads an HTTP status off an error, when the error carries one. */
function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isFinite(status) ? status : undefined;
}

/** Reads a JSON-RPC error code out of a message of the form `RPC error -32600: ...`. */
function jsonRpcCodeOf(message: string): number | undefined {
  const match = /^RPC error (-?\d+):/.exec(message);
  if (match === null) return undefined;
  return Number(match[1]);
}

/** Reads an HTTP status out of a message of the form `... failed with status 503`. */
function httpStatusFromMessage(message: string): number | undefined {
  const match = /status (-?\d+)\b/.exec(message);
  if (match === null) return undefined;
  return Number(match[1]);
}

/**
 * Decides whether an error is worth another attempt.
 *
 * Retrying is only useful when the failure was a blip: a dropped connection, a
 * timeout, a rate limit, or a server-side 5xx. Everything else — a rejected
 * parameter, a missing ledger range, a constraint violation from a write — is a
 * property of the request, and replaying it four times with backoff just burns
 * the run's budget and delays the next scheduled attempt.
 *
 * When an error carries no signal at all it is treated as transient, which is
 * the behaviour callers had before this predicate existed.
 */
export function isRetryableError(error: unknown): boolean {
  let status = httpStatusOf(error);
  if (status === undefined && error instanceof Error) {
    status = httpStatusFromMessage(error.message);
  }
  if (status !== undefined) {
    return status >= 500 || RETRYABLE_HTTP_STATUS.has(status);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.length === 0) return true;

  const code = jsonRpcCodeOf(message);
  if (code !== undefined && DETERMINISTIC_JSON_RPC_CODES.has(code)) return false;

  const lowered = message.toLowerCase();
  return !DETERMINISTIC_MARKERS.some((marker) => lowered.includes(marker));
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
