import { assertEquals, assertRejects } from '@std/assert';
import { backoffDelay, isRetryableError, withRetry } from '../supabase/functions/_shared/retry.ts';

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

Deno.test('isRetryableError retries network, 5xx, 429 and server RPC codes', () => {
  assertEquals(isRetryableError(new TypeError('error sending request for url')), true);
  assertEquals(isRetryableError(new TypeError('dns error')), true);

  const http = (status: number) => Object.assign(new Error(`status ${status}`), { status });
  assertEquals(isRetryableError(http(408)), true);
  assertEquals(isRetryableError(http(429)), true);
  assertEquals(isRetryableError(http(500)), true);
  assertEquals(isRetryableError(http(503)), true);

  assertEquals(
    isRetryableError(new Error('RPC error -32000: resource temporarily unavailable')),
    true,
  );
  assertEquals(isRetryableError(new Error('connection refused')), true);
  assertEquals(isRetryableError(new Error('econnreset')), true);
  assertEquals(
    isRetryableError(new Error('terminating connection due to administrator command')),
    true,
  );
  assertEquals(isRetryableError('a non-error rejection'), true);
});

Deno.test('isRetryableError does not retry deterministic failures', () => {
  const http = (status: number) => Object.assign(new Error(`status ${status}`), { status });
  assertEquals(isRetryableError(http(400)), false);
  assertEquals(isRetryableError(http(401)), false);
  assertEquals(isRetryableError(http(404)), false);

  // JSON-RPC request/protocol errors: the request itself is at fault.
  assertEquals(
    isRetryableError(new Error('RPC error -32600: startLedger must be within the ledger range')),
    false,
  );
  assertEquals(isRetryableError(new Error('RPC error -32601: method not found')), false);
  assertEquals(isRetryableError(new Error('RPC error -32700: parse error')), false);

  // Postgres constraint violations surface through db.ts as plain messages.
  assertEquals(
    isRetryableError(
      new Error('Failed to upsert indexed events: duplicate key value violates unique constraint'),
    ),
    false,
  );
  assertEquals(isRetryableError(new Error('violates foreign key constraint "fk"')), false);
  assertEquals(
    isRetryableError(new Error('latestLedger must be a non-negative safe integer')),
    false,
  );
});
