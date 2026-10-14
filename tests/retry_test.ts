import { assertEquals, assertRejects } from '@std/assert';
import { backoffDelay, isTransient, withRetry } from '../supabase/functions/_shared/retry.ts';
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

/** Counts attempts so the classification is asserted, not just observed. */
function countingOperation(error: unknown): { calls: () => number; op: (a: number) => Promise<never> } {
  let calls = 0;
  return {
    calls: () => calls,
    op: () => {
      calls += 1;
      return Promise.reject(error);
    },
  };
}

const CLASSIFY = { attempts: 4, baseDelayMs: 1, maxDelayMs: 4 };

Deno.test('isTransient: a deterministic RpcError is attempted once', async () => {
  const { calls, op } = countingOperation(new RpcError('RPC error -32600: startLedger must be within the ledger range'));
  await assertRejects(() =>
    withRetry(op, { ...CLASSIFY, isRetryable: isTransient, sleep: () => Promise.resolve() }),
    RpcError,
  );
  assertEquals(calls(), 1);
});

Deno.test('isTransient: a 4xx RpcError is attempted once', async () => {
  const { calls, op } = countingOperation(new RpcError('RPC request failed with status 404', 404));
  await assertRejects(() =>
    withRetry(op, { ...CLASSIFY, isRetryable: isTransient, sleep: () => Promise.resolve() }),
    RpcError,
  );
  assertEquals(calls(), 1);
});

Deno.test('isTransient: a 5xx RpcError uses the full budget', async () => {
  const { calls, op } = countingOperation(new RpcError('RPC request failed with status 503', 503));
  await assertRejects(() =>
    withRetry(op, { ...CLASSIFY, isRetryable: isTransient, sleep: () => Promise.resolve() }),
    RpcError,
  );
  assertEquals(calls(), 4);
});

Deno.test('isTransient: a network fault uses the full budget', async () => {
  const { calls, op } = countingOperation(new RpcError('RPC request failed: connection refused'));
  await assertRejects(() =>
    withRetry(op, { ...CLASSIFY, isRetryable: isTransient, sleep: () => Promise.resolve() }),
    RpcError,
  );
  assertEquals(calls(), 4);
});

Deno.test('isTransient: a Postgres constraint violation is attempted once', async () => {
  const { calls, op } = countingOperation({ code: '23505', message: 'duplicate key value violates unique constraint' });
  await assertRejects(() =>
    withRetry(op, { ...CLASSIFY, isRetryable: isTransient, sleep: () => Promise.resolve() }),
  );
  assertEquals(calls(), 1);
});

Deno.test('isTransient: a Postgres transport error uses the full budget', async () => {
  const { calls, op } = countingOperation({ code: '08006', message: 'connection failure' });
  await assertRejects(() =>
    withRetry(op, { ...CLASSIFY, isRetryable: isTransient, sleep: () => Promise.resolve() }),
  );
  assertEquals(calls(), 4);
});
