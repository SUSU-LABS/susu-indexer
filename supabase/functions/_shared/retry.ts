/**
 * Retry with exponential backoff.
 *
 * The indexer depends on an external RPC and a database, both of which can fail
 * transiently. Retries are bounded so a scheduled run cannot hang until the
 * platform kills it, and the checkpoint is unaffected by a failed attempt —
 * a partially processed range is simply retried on the next run.
 */

import { RpcError } from './stellar.ts';

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
 * Retry classification shared by the scan and the run loop.
 *
 * Only a transient failure deserves another attempt: a network fault, a
 * timeout, HTTP 408/429/5xx, or a database transport error (SQLSTATE 08xxx).
 * A deterministic fault — a 4xx response, a JSON-RPC protocol error such as
 * -32600, or a Postgres constraint violation — cannot be repaired by
 * waiting, so it is attempted once.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof RpcError) {
    if (error.status !== undefined) {
      return error.status === 408 || error.status === 429 || error.status >= 500;
    }
    // Without an HTTP status the fetch layer distinguishes transport from
    // protocol: 'RPC request failed: <cause>' is the network fault; 'RPC error
    // -32600: ...' is the deterministic one.
    return error.message.startsWith('RPC request failed');
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    return code.startsWith('08');
  }
  return false;
}
