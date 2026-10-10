import { assertEquals, assertRejects } from '@std/assert';
import {
  backoffDelay,
  defaultIsRetryable,
  withRetry,
} from '../supabase/functions/_shared/retry.ts';
import { RpcError } from '../supabase/functions/_shared/stellar.ts';

/** Records delays instead of actually sleeping, so tests run instantly. */
function recordingSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

Deno.test('backoffDelay grows exponentially', () => {
  assertEquals(backoffDelay(1, 100, 10_000), 100);
  assertEquals(backoffDelay(2, 100, 10_000), 200);
  assertEquals(backoffDelay(3, 100, 10_000), 400);
  assertEquals(backoffDelay(4, 100, 10_000), 800);
});

Deno.test('backoffDelay is capped at maxDelayMs', () => {
  assertEquals(backoffDelay(10, 100, 5_000), 5_000);
});

Deno.test('withRetry returns immediately on success', async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  const result = await withRetry(
    () => {
      calls++;
      return Promise.resolve('ok');
    },
    { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep },
  );

  assertEquals(result, 'ok');
  assertEquals(calls, 1);
  assertEquals(delays.length, 0);
});

Deno.test('withRetry retries a transient failure then succeeds', async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  const result = await withRetry(
    () => {
      calls++;
      if (calls < 3) return Promise.reject(new Error('transient'));
      return Promise.resolve('recovered');
    },
    { attempts: 5, baseDelayMs: 10, maxDelayMs: 100, sleep },
  );

  assertEquals(result, 'recovered');
  assertEquals(calls, 3);
  assertEquals(delays, [10, 20]);
});

Deno.test('withRetry rethrows after exhausting attempts', async () => {
  const { sleep } = recordingSleep();
  let calls = 0;

  await assertRejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(new Error('persistent'));
        },
        { attempts: 3, baseDelayMs: 10, maxDelayMs: 100, sleep },
      ),
    Error,
    'persistent',
  );

  assertEquals(calls, 3);
});

Deno.test('withRetry stops immediately for non-retryable errors', async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  await assertRejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(new Error('fatal'));
        },
        {
          attempts: 5,
          baseDelayMs: 10,
          maxDelayMs: 100,
          sleep,
          isRetryable: () => false,
        },
      ),
    Error,
    'fatal',
  );

  assertEquals(calls, 1);
  assertEquals(delays.length, 0);
});

Deno.test('withRetry rejects an invalid attempt budget', async () => {
  await assertRejects(
    () => withRetry(() => Promise.resolve('ok'), { attempts: 0, baseDelayMs: 1, maxDelayMs: 1 }),
    Error,
    'attempts >= 1',
  );
});

// ---------------------------------------------------------------------------
// defaultIsRetryable: deterministic failures are not retried.
// ---------------------------------------------------------------------------

Deno.test('defaultIsRetryable retries network errors', () => {
  assertEquals(defaultIsRetryable(new TypeError('fetch failed')), true);
  assertEquals(defaultIsRetryable(new Error('connection refused')), true);
});

Deno.test('defaultIsRetryable retries timeouts', () => {
  const timeout = new DOMException('The operation timed out', 'TimeoutError');
  assertEquals(defaultIsRetryable(timeout), true);
  const abort = new DOMException('The operation was aborted', 'AbortError');
  assertEquals(defaultIsRetryable(abort), true);
  assertEquals(
    defaultIsRetryable(new RpcError('Soroban RPC request timed out after 15000ms')),
    true,
  );
});

Deno.test('defaultIsRetryable retries HTTP 408/429/5xx but not other 4xx', () => {
  assertEquals(defaultIsRetryable(new RpcError('slow', 408)), true);
  assertEquals(defaultIsRetryable(new RpcError('limited', 429)), true);
  assertEquals(defaultIsRetryable(new RpcError('boom', 500)), true);
  assertEquals(defaultIsRetryable(new RpcError('bad gateway', 502)), true);
  assertEquals(defaultIsRetryable(new RpcError('bad request', 400)), false);
  assertEquals(defaultIsRetryable(new RpcError('not found', 404)), false);
  assertEquals(defaultIsRetryable(new RpcError('unprocessable', 422)), false);
});

Deno.test('defaultIsRetryable does not retry deterministic JSON-RPC errors', () => {
  // -32600: the documented startLedger-outside-retention case.
  assertEquals(
    defaultIsRetryable(
      new RpcError('RPC error -32600: startLedger must be within the ledger range'),
    ),
    false,
  );
  assertEquals(defaultIsRetryable(new RpcError('RPC error -32601: method not found')), false);
  assertEquals(defaultIsRetryable(new RpcError('RPC error -32602: invalid params')), false);
});

Deno.test('defaultIsRetryable does not retry Postgres constraint violations', () => {
  assertEquals(
    defaultIsRetryable(
      new Error(
        'Failed to upsert indexed events: duplicate key value violates unique constraint "decoded_events_pkey"',
      ),
    ),
    false,
  );
  assertEquals(
    defaultIsRetryable(
      new Error('null value in column "x" violates not-null constraint "x_not_null"'),
    ),
    false,
  );
  assertEquals(
    defaultIsRetryable(
      new Error('insert or update on table "y" violates foreign key constraint "y_fkey"'),
    ),
    false,
  );
});

Deno.test('defaultIsRetryable retries unrecognized errors (fail-open)', () => {
  assertEquals(defaultIsRetryable(new Error('something new and weird')), true);
  assertEquals(defaultIsRetryable('a bare string'), true);
});

/** Counts attempts; the operation always fails with `error`. */
async function countAttempts(error: unknown, attempts = 4): Promise<number> {
  let calls = 0;
  const { sleep } = recordingSleep();
  await assertRejects(() =>
    withRetry(
      () => {
        calls++;
        return Promise.reject(error);
      },
      { attempts, baseDelayMs: 1, maxDelayMs: 2, sleep },
    )
  );
  return calls;
}

Deno.test('withRetry attempts a 4xx RpcError exactly once by default', async () => {
  assertEquals(await countAttempts(new RpcError('RPC request failed with status 400', 400)), 1);
});

Deno.test('withRetry retries a 5xx RpcError through the full budget by default', async () => {
  assertEquals(await countAttempts(new RpcError('RPC request failed with status 503', 503)), 4);
});

Deno.test('withRetry attempts a -32600 RpcError exactly once by default', async () => {
  assertEquals(
    await countAttempts(
      new RpcError('RPC error -32600: startLedger must be within the ledger range'),
    ),
    1,
  );
});

Deno.test('withRetry attempts a constraint violation exactly once by default', async () => {
  assertEquals(
    await countAttempts(
      new Error(
        'Failed to upsert indexed events: duplicate key value violates unique constraint "decoded_events_pkey"',
      ),
    ),
    1,
  );
});
