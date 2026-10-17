import { assertEquals, assertRejects } from '@std/assert';
import { backoffDelay, isRetryableError, withRetry } from '../supabase/functions/_shared/retry.ts';
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
// Error classification & deterministic error handling
// ---------------------------------------------------------------------------

Deno.test('isRetryableError classifies deterministic RPC and DB errors as non-retryable', () => {
  // JSON-RPC deterministic codes
  assertEquals(
    isRetryableError(new RpcError('startLedger must be within the ledger range', -32600)),
    false,
  );
  assertEquals(isRetryableError(new RpcError('method not found', -32601)), false);
  assertEquals(isRetryableError(new RpcError('invalid params', -32602)), false);
  assertEquals(isRetryableError(new RpcError('parse error', -32700)), false);

  // HTTP 4xx deterministic client codes
  assertEquals(isRetryableError(new RpcError('bad request', 400)), false);
  assertEquals(isRetryableError(new RpcError('unauthorized', 401)), false);
  assertEquals(isRetryableError(new RpcError('forbidden', 403)), false);
  assertEquals(isRetryableError(new RpcError('not found', 404)), false);

  // Postgres constraint violations
  assertEquals(
    isRetryableError(
      new Error('duplicate key value violates unique constraint "indexed_events_pkey"'),
    ),
    false,
  );
  assertEquals(
    isRetryableError(
      new Error('insert or update on table "group_members" violates foreign key constraint'),
    ),
    false,
  );
  assertEquals(
    isRetryableError(
      new Error('new row for relation "indexer_checkpoints" violates check constraint'),
    ),
    false,
  );
});

Deno.test('isRetryableError classifies transient RPC, network and DB errors as retryable', () => {
  // HTTP transient codes
  assertEquals(isRetryableError(new RpcError('request timeout', 408)), true);
  assertEquals(isRetryableError(new RpcError('rate limited', 429)), true);
  assertEquals(isRetryableError(new RpcError('internal server error', 500)), true);
  assertEquals(isRetryableError(new RpcError('bad gateway', 502)), true);
  assertEquals(isRetryableError(new RpcError('service unavailable', 503)), true);
  assertEquals(isRetryableError(new RpcError('gateway timeout', 504)), true);

  // JSON-RPC server implementation codes
  assertEquals(isRetryableError(new RpcError('internal json-rpc error', -32603)), true);
  assertEquals(isRetryableError(new RpcError('server error', -32000)), true);

  // Network / fetch errors
  assertEquals(isRetryableError(new TypeError('fetch failed')), true);
  assertEquals(isRetryableError(new Error('connection reset by peer')), true);
  assertEquals(isRetryableError(new Error('network timeout')), true);
});

Deno.test('withRetry with isRetryableError stops on first attempt for -32600', async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  await assertRejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(
            new RpcError('startLedger must be within the ledger range', -32600),
          );
        },
        {
          attempts: 4,
          baseDelayMs: 250,
          maxDelayMs: 4000,
          sleep,
          isRetryable: isRetryableError,
        },
      ),
    RpcError,
    'startLedger must be within the ledger range',
  );

  assertEquals(calls, 1);
  assertEquals(delays.length, 0);
});

Deno.test('withRetry with isRetryableError retries transient 503 up to attempt budget', async () => {
  const { delays, sleep } = recordingSleep();
  let calls = 0;

  await assertRejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(new RpcError('service unavailable', 503));
        },
        {
          attempts: 4,
          baseDelayMs: 250,
          maxDelayMs: 4000,
          sleep,
          isRetryable: isRetryableError,
        },
      ),
    RpcError,
    'service unavailable',
  );

  assertEquals(calls, 4);
  assertEquals(delays, [250, 500, 1000]);
});
