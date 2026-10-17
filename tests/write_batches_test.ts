import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  batches,
  type IndexedEventRow,
  IndexerDb,
  type NewGroup,
  type RejectedEventRow,
  WRITE_BATCH_SIZE,
} from '../supabase/functions/_shared/db.ts';
import type {
  ContributionRow,
  DecodedEventRow,
  GroupMemberRow,
  IngestPlan,
  PayoutRow,
  ProtocolFeeRow,
} from '../supabase/functions/_shared/ingest.ts';

type RecordedUpsert = {
  table: string;
  rows: Record<string, unknown>[];
  options?: { onConflict?: string; ignoreDuplicates?: boolean };
};

class RecordingStubClient {
  readonly upserts: RecordedUpsert[] = [];
  failOnBatchIndex: { table: string; index: number; error: Error } | null = null;
  #batchCounters = new Map<string, number>();

  from(table: string) {
    return {
      upsert: (
        rows: Record<string, unknown>[],
        options?: { onConflict?: string; ignoreDuplicates?: boolean },
      ) => {
        const count = this.#batchCounters.get(table) ?? 0;
        this.#batchCounters.set(table, count + 1);

        if (
          this.failOnBatchIndex &&
          this.failOnBatchIndex.table === table &&
          this.failOnBatchIndex.index === count
        ) {
          return Promise.resolve({ error: this.failOnBatchIndex.error });
        }

        this.upserts.push({ table, rows: [...rows], options });
        return Promise.resolve({ error: null });
      },
    };
  }

  tableUpserts(table: string): RecordedUpsert[] {
    return this.upserts.filter((u) => u.table === table);
  }
}

function makeSyntheticEvent(i: number): IndexedEventRow {
  return {
    event_identity: `evt-${i}`,
    ledger: 1000 + i,
    tx_hash: `hash-${i}`,
    tx_index: 0,
    event_index: i,
    contract_id: `CAAA${i}`,
    topic: ['transfer'],
    value: '{}',
  };
}

function makeSyntheticRejected(i: number): RejectedEventRow {
  return {
    event_id: `rej-${i}`,
    ledger: 1000 + i,
    tx_hash: `hash-${i}`,
    tx_index: 0,
    event_index: i,
    contract_id: `CAAA${i}`,
    reason: `unrecognised topic ${i}`,
  };
}

function makeSyntheticGroup(i: number): NewGroup {
  return {
    contract_id: `CGRP${i}`,
    factory_contract_id: 'CFACTORY',
    group_id: i,
    creator: 'GCREATOR',
    token: 'CTOKEN',
    contribution_amount: '10000000',
    member_capacity: 5,
    created_ledger: 1000 + i,
  };
}

Deno.test('batches helper partitions elements into bounded chunks', () => {
  assertEquals(batches([], 10), []);
  assertEquals(batches([1, 2, 3], 10), [[1, 2, 3]]);
  assertEquals(batches([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  assertEquals(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assertEquals(WRITE_BATCH_SIZE, 1000);

  assertThrows(
    () => {
      batches([1], 0);
    },
    RangeError,
    'Batch size must be greater than 0',
  );
});

Deno.test('upsertEvents chunks writes into requests no larger than batchSize', async () => {
  const client = new RecordingStubClient();
  const db = new IndexerDb(
    'https://example.supabase.co',
    'dummy-key',
    client as unknown as SupabaseClient,
    10,
  );

  const rows = Array.from({ length: 25 }, (_, i) => makeSyntheticEvent(i));
  await db.upsertEvents(rows);

  const calls = client.tableUpserts('indexed_events');
  assertEquals(calls.length, 3);
  assertEquals(calls[0]?.rows.length, 10);
  assertEquals(calls[1]?.rows.length, 10);
  assertEquals(calls[2]?.rows.length, 5);

  for (const call of calls) {
    assert(call.rows.length <= 10, 'Request exceeded configured batch size');
    assertEquals(call.options, { onConflict: 'event_identity', ignoreDuplicates: true });
  }

  // Verify all rows committed exactly once across boundaries
  const writtenIdentities = calls.flatMap((c) => c.rows.map((r) => r['event_identity']));
  assertEquals(writtenIdentities, rows.map((r) => r.event_identity));
});

Deno.test('recordRejectedEvents chunks writes and attaches correlationId', async () => {
  const client = new RecordingStubClient();
  const db = new IndexerDb(
    'https://example.supabase.co',
    'dummy-key',
    client as unknown as SupabaseClient,
    5,
  );

  const rows = Array.from({ length: 12 }, (_, i) => makeSyntheticRejected(i));
  await db.recordRejectedEvents('corr-123', rows);

  const calls = client.tableUpserts('indexer_rejected_events');
  assertEquals(calls.length, 3);
  assertEquals(calls[0]?.rows.length, 5);
  assertEquals(calls[1]?.rows.length, 5);
  assertEquals(calls[2]?.rows.length, 2);

  for (const call of calls) {
    assert(call.rows.length <= 5);
    assertEquals(call.options, { onConflict: 'event_id', ignoreDuplicates: true });
    for (const r of call.rows) {
      assertEquals(r['correlation_id'], 'corr-123');
    }
  }

  const writtenIds = calls.flatMap((c) => c.rows.map((r) => r['event_id']));
  assertEquals(writtenIds, rows.map((r) => r.event_id));
});

Deno.test('upsertGroups chunks writes into requests no larger than batchSize', async () => {
  const client = new RecordingStubClient();
  const db = new IndexerDb(
    'https://example.supabase.co',
    'dummy-key',
    client as unknown as SupabaseClient,
    4,
  );

  const rows = Array.from({ length: 9 }, (_, i) => makeSyntheticGroup(i));
  await db.upsertGroups(rows);

  const calls = client.tableUpserts('groups');
  assertEquals(calls.length, 3);
  assertEquals(calls[0]?.rows.length, 4);
  assertEquals(calls[1]?.rows.length, 4);
  assertEquals(calls[2]?.rows.length, 1);

  const writtenContracts = calls.flatMap((c) => c.rows.map((r) => r['contract_id']));
  assertEquals(writtenContracts, rows.map((r) => r.contract_id));
});

Deno.test('persistPlan chunks writes across all five plan tables', async () => {
  const client = new RecordingStubClient();
  const db = new IndexerDb(
    'https://example.supabase.co',
    'dummy-key',
    client as unknown as SupabaseClient,
    5,
  );

  const decoded: DecodedEventRow[] = Array.from({ length: 11 }, (_, i) => ({
    event_identity: `dec-${i}`,
    name: 'contributed',
    contract_id: 'C1',
    ledger: 1000 + i,
    tx_hash: `hash-${i}`,
    tx_index: 0,
    event_index: i,
    event_id: `eid-${i}`,
    payload: {},
  }));

  const members: GroupMemberRow[] = Array.from({ length: 7 }, (_, i) => ({
    contract_id: 'C1',
    member: `G${i}`,
    position: i,
    joined_ledger: 1000,
    event_identity: `mid-${i}`,
  }));

  const contributions: ContributionRow[] = Array.from({ length: 8 }, (_, i) => ({
    event_identity: `contrib-${i}`,
    contract_id: 'C1',
    round: 1,
    member: `G${i}`,
    amount: '10000000',
    ledger: 1000 + i,
    tx_hash: `tx-${i}`,
  }));

  const payouts: PayoutRow[] = Array.from({ length: 6 }, (_, i) => ({
    event_identity: `pay-${i}`,
    contract_id: 'C1',
    round: 1,
    recipient: `G${i}`,
    recipient_amount: '10000000',
    ledger: 1000 + i,
    tx_hash: `tx-${i}`,
  }));

  const fees: ProtocolFeeRow[] = Array.from({ length: 6 }, (_, i) => ({
    event_identity: `fee-${i}`,
    contract_id: 'C1',
    treasury: 'CTREASURY',
    round: 1,
    fee: '100000',
    ledger: 1000 + i,
    tx_hash: `tx-${i}`,
  }));

  const plan: IngestPlan = {
    decoded,
    members,
    contributions,
    payouts,
    fees,
    touchedGroups: ['C1'],
  };

  await db.persistPlan(plan);

  const decodedCalls = client.tableUpserts('decoded_events');
  assertEquals(decodedCalls.length, 3); // 5, 5, 1
  assertEquals(decodedCalls[0]?.rows.length, 5);
  assertEquals(decodedCalls[1]?.rows.length, 5);
  assertEquals(decodedCalls[2]?.rows.length, 1);

  const membersCalls = client.tableUpserts('group_members');
  assertEquals(membersCalls.length, 2); // 5, 2
  assertEquals(membersCalls[0]?.rows.length, 5);
  assertEquals(membersCalls[1]?.rows.length, 2);

  const contributionsCalls = client.tableUpserts('contributions');
  assertEquals(contributionsCalls.length, 2); // 5, 3
  assertEquals(contributionsCalls[0]?.rows.length, 5);
  assertEquals(contributionsCalls[1]?.rows.length, 3);

  const payoutsCalls = client.tableUpserts('payouts');
  assertEquals(payoutsCalls.length, 2); // 5, 1
  assertEquals(payoutsCalls[0]?.rows.length, 5);
  assertEquals(payoutsCalls[1]?.rows.length, 1);

  const feesCalls = client.tableUpserts('protocol_fees');
  assertEquals(feesCalls.length, 2); // 5, 1
  assertEquals(feesCalls[0]?.rows.length, 5);
  assertEquals(feesCalls[1]?.rows.length, 1);
});

Deno.test('mid-batch failure aborts immediately and does not attempt subsequent batches', async () => {
  const client = new RecordingStubClient();
  client.failOnBatchIndex = {
    table: 'indexed_events',
    index: 1, // Fail on second batch (index 1)
    error: new Error('PostgREST 504 Gateway Timeout on batch 2'),
  };

  const db = new IndexerDb(
    'https://example.supabase.co',
    'dummy-key',
    client as unknown as SupabaseClient,
    10,
  );

  const rows = Array.from({ length: 30 }, (_, i) => makeSyntheticEvent(i));

  await assertRejects(
    () => db.upsertEvents(rows),
    Error,
    'Failed to upsert indexed events: PostgREST 504 Gateway Timeout on batch 2',
  );

  // Assert batch 1 succeeded, batch 2 failed, and batch 3 was NEVER attempted
  const calls = client.tableUpserts('indexed_events');
  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.rows.length, 10);
});
