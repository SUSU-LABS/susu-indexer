import { assertEquals, assertExists } from '@std/assert';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import { handleRequest, type RpcSource } from '../supabase/functions/indexer/index.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

Deno.test('recordRunFailure never rejects when the insert promise rejects with a network error', async () => {
  const rejectingClient = {
    from: () => ({
      insert: () => Promise.reject(new Error('Connection reset by peer')),
    }),
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', rejectingClient);

  // Must not throw or reject
  await db.recordRunFailure({
    correlationId: 'test-corr-1',
    ledgerFrom: 100,
    ledgerTo: 200,
    reason: 'upstream failure',
  });
});

Deno.test('recordRunFailure never rejects when the insert returns a Postgrest error object', async () => {
  const errorClient = {
    from: () => ({
      insert: () => Promise.resolve({ error: { message: 'relation does not exist' } }),
    }),
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', errorClient);

  // Must not throw or reject
  await db.recordRunFailure({
    correlationId: 'test-corr-2',
    ledgerFrom: 100,
    ledgerTo: 200,
    reason: 'upstream failure',
  });
});

Deno.test('recordRunFailure succeeds on clean insert', async () => {
  let insertedPayload: unknown = null;
  const successClient = {
    from: () => ({
      insert: (payload: unknown) => {
        insertedPayload = payload;
        return Promise.resolve({ error: null });
      },
    }),
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', successClient);

  await db.recordRunFailure({
    correlationId: 'test-corr-3',
    ledgerFrom: 100,
    ledgerTo: 200,
    reason: 'test reason',
  });

  assertExists(insertedPayload);
  const p = insertedPayload as Record<string, unknown>;
  assertEquals(p['correlation_id'], 'test-corr-3');
  assertEquals(p['status'], 'failed');
  assertEquals(p['reason'], 'test reason');
});

Deno.test('handleRequest returns structured 500 when indexer run fails and recordRunFailure insert rejects', async () => {
  const dummyConfig = {
    supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'service-role-key',
    taskSecret: 'a'.repeat(48),
    rpcUrl: 'https://soroban-testnet.stellar.org',
    network: 'testnet' as const,
    networkPassphrase: 'Test SDF Network ; September 2015',
    factoryContractId: `C${'A'.repeat(55)}`,
    usdcContractId: `C${'B'.repeat(55)}`,
    startLedger: 1,
    maxLedgersPerRun: 1000,
    allowMainnet: false,
  };

  // Create a mock DB where getCheckpoint throws (causing indexer run failure)
  // AND recordRunFailure rejects (simulating unhandled rejection if not properly caught)
  const throwingDb = {
    getCheckpoint: () => Promise.reject(new Error('Database unreachable')),
    recordRunFailure: () => Promise.reject(new Error('Insert rejected')),
  } as unknown as IndexerDb;

  const request = new Request('https://indexer.example.com/', {
    headers: {
      'x-indexer-task-secret': 'a'.repeat(48),
    },
  });

  const response = await handleRequest(request, { db: throwingDb, config: dummyConfig });

  assertEquals(response.status, 500);
  assertEquals(response.headers.get('content-type'), 'application/json');

  const body = await response.json();
  assertEquals(body.status, 'failed');
  assertExists(body.correlationId);
  assertEquals(body.reason, 'Database unreachable');
});

Deno.test('handleRequest records the computed ledger range when a mid-run failure occurs', async () => {
  const dummyConfig = {
    supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'service-role-key',
    taskSecret: 'a'.repeat(48),
    rpcUrl: 'https://soroban-testnet.stellar.org',
    network: 'testnet' as const,
    networkPassphrase: 'Test SDF Network ; September 2015',
    factoryContractId: `C${'A'.repeat(55)}`,
    usdcContractId: `C${'B'.repeat(55)}`,
    startLedger: 1,
    maxLedgersPerRun: 1000,
    allowMainnet: false,
  };

  const recordedCalls: Array<{
    correlationId: string;
    ledgerFrom: number;
    ledgerTo: number;
    reason: string;
  }> = [];

  // Checkpoint at 99, latest ledger 250 -> computed range { from: 100, to: 250 }.
  // listGroupContractIds throws, simulating a failure after the range is
  // computed but before any writes happen.
  const midRunFailureDb = {
    getCheckpoint: () => Promise.resolve({ lastProcessedLedger: 99, startLedger: 1 }),
    listGroupContractIds: () => Promise.reject(new Error('RPC exploded mid-run')),
    recordRunFailure: (params: {
      correlationId: string;
      ledgerFrom: number;
      ledgerTo: number;
      reason: string;
    }) => {
      recordedCalls.push(params);
      return Promise.resolve();
    },
  } as unknown as IndexerDb;

  const rpc = {
    getLatestLedger: () => Promise.resolve(250),
  };

  const request = new Request('https://indexer.example.com/', {
    headers: {
      'x-indexer-task-secret': 'a'.repeat(48),
    },
  });

  const response = await handleRequest(request, {
    db: midRunFailureDb,
    rpc: rpc as unknown as RpcSource,
    config: dummyConfig,
  });

  assertEquals(response.status, 500);
  assertEquals(recordedCalls.length, 1);
  const recorded = recordedCalls[0];
  assertExists(recorded);
  assertEquals(recorded.ledgerFrom, 100);
  assertEquals(recorded.ledgerTo, 250);
  assertEquals(recorded.reason, 'RPC exploded mid-run');
});

Deno.test('handleRequest records 0/0 when the failure happens before the range is computed', async () => {
  const dummyConfig = {
    supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'service-role-key',
    taskSecret: 'a'.repeat(48),
    rpcUrl: 'https://soroban-testnet.stellar.org',
    network: 'testnet' as const,
    networkPassphrase: 'Test SDF Network ; September 2015',
    factoryContractId: `C${'A'.repeat(55)}`,
    usdcContractId: `C${'B'.repeat(55)}`,
    startLedger: 1,
    maxLedgersPerRun: 1000,
    allowMainnet: false,
  };

  const recordedCalls: Array<{ ledgerFrom: number; ledgerTo: number }> = [];

  // getCheckpoint throws, so no range is ever computed.
  const earlyFailureDb = {
    getCheckpoint: () => Promise.reject(new Error('Database unreachable')),
    recordRunFailure: (params: { ledgerFrom: number; ledgerTo: number }) => {
      recordedCalls.push(params);
      return Promise.resolve();
    },
  } as unknown as IndexerDb;

  const request = new Request('https://indexer.example.com/', {
    headers: {
      'x-indexer-task-secret': 'a'.repeat(48),
    },
  });

  const response = await handleRequest(request, { db: earlyFailureDb, config: dummyConfig });

  assertEquals(response.status, 500);
  assertEquals(recordedCalls.length, 1);
  const recorded = recordedCalls[0];
  assertExists(recorded);
  assertEquals(recorded.ledgerFrom, 0);
  assertEquals(recorded.ledgerTo, 0);
});
