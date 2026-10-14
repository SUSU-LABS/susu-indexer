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

/** Runs `withRetry` against an error that never heals, and counts the attempts used. */
async function attemptsFor(error: Error): Promise<number> {
  const { sleep } = recordingSleep();
  let calls = 0;

  await assertRejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(error);
        },
        { attempts: 4, baseDelayMs: 10, maxDelayMs: 100, sleep, isRetryable: isRetryableError },
      ),
    Error,
  );

  return calls;
}

Deno.test('isRetryableError keeps the budget for network blips', () => {
  assertEquals(isRetryableError(new TypeError('fetch failed')), true);
  assertEquals(isRetryableError(new Error('Deadline exceeded while reading')), true);
  assertEquals(isRetryableError(new Error('RPC request failed with status 503')), true);
});

Deno.test('isRetryableError spends one attempt on a rejected request', () => {
  assertEquals(
    isRetryableError(new Error('RPC error -32600: startLedger must be within the ledger range')),
    false,
  );
  assertEquals(isRetryableError(new Error('RPC request failed with status 404')), false);
});

Deno.test('a transient failure uses the whole attempt budget', async () => {
  assertEquals(await attemptsFor(new TypeError('fetch failed')), 4);
});

Deno.test('a deterministic rejection is attempted once', async () => {
  const error = new Error('RPC error -32600: startLedger must be within the ledger range');
  assertEquals(await attemptsFor(error), 1);
});

Deno.test('a constraint violation from a write is attempted once', async () => {
  const error = new Error('duplicate key value violates unique constraint "events_pkey"');
  assertEquals(await attemptsFor(error), 1);
});
