/**
 * Endpoint-level failure-injection tests for the indexer retry path.
 *
 * These tests drive the real `handleRequest` with scripted stub clients that
 * fail transiently and then recover, asserting the run-level outcomes required
 * by SUSU-LABS/susu-indexer#49:
 *
 * - a transient `getEvents` failure followed by success yields `status: 'ok'`,
 *   completed writes, a single checkpoint advance, and no failure row;
 * - a transient DB `upsert` failure followed by success behaves the same;
 * - a permanently failing dependency leaves the checkpoint untouched and
 *   records exactly one failure row.
 *
 * The injected `sleep` records delays instead of waiting, so the tests run
 * without real delays.
 */

import { assert, assertEquals } from '@std/assert';
import { handleRequest } from '../supabase/functions/indexer/index.ts';
import type { RetryOptions } from '../supabase/functions/_shared/retry.ts';
import type { Checkpoint } from '../supabase/functions/_shared/checkpoint.ts';
import type { GetEventsResult } from '../supabase/functions/_shared/stellar.ts';
import type { IndexerDb } from '../supabase/functions/_shared/db.ts';
import type { RpcSource } from '../supabase/functions/indexer/index.ts';

const TASK_SECRET = 'test-task-secret-00000000000000000000';
const FACTORY_ID = `C${'A'.repeat(55)}`;
const USDC_ID = `C${'B'.repeat(55)}`;
const FROM_LEDGER = 1000;
const HEAD_LEDGER = 1010;

function testEnv(): Record<string, string | undefined> {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    INDEXER_TASK_SECRET: TASK_SECRET,
    STELLAR_RPC_URL: 'https://rpc.example.com',
    STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    FACTORY_CONTRACT_ID: FACTORY_ID,
    USDC_CONTRACT_ID: USDC_ID,
    INDEXER_START_LEDGER: String(FROM_LEDGER),
  };
}

function authorizedRequest(): Request {
  return new Request('http://localhost/', {
    headers: { 'x-indexer-task-secret': TASK_SECRET },
  });
}

/** Records delays instead of sleeping, so tests run without real delays. */
function testRetry(): { retry: RetryOptions; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    retry: {
      attempts: 4,
      baseDelayMs: 250,
      maxDelayMs: 4_000,
      sleep: (ms: number) => {
        delays.push(ms);
        return Promise.resolve();
      },
    },
  };
}

/**
 * Scripted RPC client. `getEvents` fails the first `failTimes` calls with a
 * transient error, then succeeds. `getLatestLedger` always succeeds.
 */
class FailingRpc {
  getEventsCalls = 0;

  constructor(private readonly failTimes: number) {}

  getLatestLedger(): Promise<number> {
    return Promise.resolve(HEAD_LEDGER);
  }

  getEvents(
    _params: { contractIds: string[]; limit?: number },
  ): Promise<GetEventsResult> {
    this.getEventsCalls++;
    if (this.getEventsCalls <= this.failTimes) {
      return Promise.reject(new Error('transient RPC failure'));
    }
    return Promise.resolve({ events: [] });
  }

  asRpcSource(): RpcSource {
    return this as unknown as RpcSource;
  }
}

type FailureRow = {
  correlationId: string;
  ledgerFrom: number;
  ledgerTo: number;
  reason: string;
};

/**
 * Minimal in-memory stand-in for IndexerDb.
 *
 * `failUpsertEventsTimes` makes the first N `upsertEvents` calls throw a
 * transient error; `failAll` makes every fallible operation throw permanently.
 * Tracks the checkpoint and recorded failures so tests can assert
 * exactly-once advancement and failure recording.
 */
class StubDb {
  checkpoint: Checkpoint | undefined;
  failures: FailureRow[] = [];
  upsertEventsCalls = 0;
  advanceCheckpointCalls = 0;

  constructor(
    private readonly failUpsertEventsTimes = 0,
    private readonly failUpsertEventsAlways = false,
  ) {}

  getCheckpoint(): Promise<Checkpoint | undefined> {
    return Promise.resolve(this.checkpoint);
  }

  recordLatestLedger(_latestLedger: number): Promise<void> {
    return Promise.resolve();
  }

  listGroupContractIds(): Promise<string[]> {
    return Promise.resolve([]);
  }

  upsertGroups(_groups: unknown[]): Promise<void> {
    return Promise.resolve();
  }

  upsertEvents(_rows: unknown[]): Promise<void> {
    this.upsertEventsCalls++;
    if (this.failUpsertEventsAlways) {
      return Promise.reject(new Error('permanent upsert failure'));
    }
    if (this.upsertEventsCalls <= this.failUpsertEventsTimes) {
      return Promise.reject(new Error('transient upsert failure'));
    }
    return Promise.resolve();
  }

  recordRejectedEvents(_correlationId: string, _rows: unknown[]): Promise<void> {
    return Promise.resolve();
  }

  persistPlan(_plan: unknown): Promise<void> {
    return Promise.resolve();
  }

  readDerivedGroupState(_contractIds: readonly string[]): Promise<never[]> {
    return Promise.resolve([]);
  }

  readGroupState(_contractIds: readonly string[]): Promise<Map<string, unknown>> {
    return Promise.resolve(new Map());
  }

  upsertGroupState(_states: unknown[]): Promise<void> {
    return Promise.resolve();
  }

  advanceCheckpoint(params: {
    lastProcessedLedger: number;
    startLedger: number;
    lastSeenLatestLedger?: number;
  }): Promise<void> {
    this.advanceCheckpointCalls++;
    this.checkpoint = {
      lastProcessedLedger: params.lastProcessedLedger,
      startLedger: params.startLedger,
      updatedAt: new Date().toISOString(),
    };
    return Promise.resolve();
  }

  recordRunFailure(params: {
    correlationId: string;
    ledgerFrom: number;
    ledgerTo: number;
    reason: string;
  }): Promise<void> {
    // recordRunFailure never throws by contract; record even in failAll mode.
    this.failures.push({ ...params });
    return Promise.resolve();
  }

  asIndexerDb(): IndexerDb {
    return this as unknown as IndexerDb;
  }
}

Deno.test('transient getEvents failure then success yields ok, no failure row', async () => {
  const rpc = new FailingRpc(2); // fail twice, then succeed
  const db = new StubDb();
  const { retry, delays } = testRetry();

  const response = await handleRequest(authorizedRequest(), {
    db: db.asIndexerDb(),
    rpc: rpc.asRpcSource(),
    env: testEnv(),
    retry,
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.status, 'ok');
  // The checkpoint advanced exactly once, to the head ledger.
  assertEquals(db.advanceCheckpointCalls, 1);
  assertEquals(db.checkpoint?.lastProcessedLedger, HEAD_LEDGER);
  // No failure was recorded.
  assertEquals(db.failures.length, 0);
  // Retries happened without real waiting.
  assert(delays.length >= 2, `expected >=2 recorded delays, got ${delays.length}`);
});

Deno.test('transient DB upsert failure then success yields ok, no failure row', async () => {
  const rpc = new FailingRpc(0);
  const db = new StubDb(1); // first upsertEvents fails, then succeeds
  const { retry, delays } = testRetry();

  const response = await handleRequest(authorizedRequest(), {
    db: db.asIndexerDb(),
    rpc: rpc.asRpcSource(),
    env: testEnv(),
    retry,
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.status, 'ok');
  assertEquals(db.advanceCheckpointCalls, 1);
  assertEquals(db.checkpoint?.lastProcessedLedger, HEAD_LEDGER);
  assertEquals(db.failures.length, 0);
  assert(delays.length >= 1, `expected >=1 recorded delay, got ${delays.length}`);
  assertEquals(db.upsertEventsCalls, 2);
});

Deno.test('permanent failure leaves checkpoint untouched, records one failure', async () => {
  const rpc = new FailingRpc(0);
  const db = new StubDb(0, true); // upsertEvents always fails
  const { retry } = testRetry();
  const before = db.checkpoint;

  const response = await handleRequest(authorizedRequest(), {
    db: db.asIndexerDb(),
    rpc: rpc.asRpcSource(),
    env: testEnv(),
    retry,
  });

  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body.status, 'failed');
  // Checkpoint untouched.
  assertEquals(db.checkpoint, before);
  assertEquals(db.advanceCheckpointCalls, 0);
  // Exactly one failure row recorded.
  assertEquals(db.failures.length, 1);
  assertEquals(db.failures[0]?.ledgerFrom, FROM_LEDGER);
});
