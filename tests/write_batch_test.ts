import { assert, assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from 'npm:@supabase/supabase-js';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import type { IndexedEventRow } from '../supabase/functions/_shared/db.ts';

/**
 * #38: writes must be chunked so no single PostgREST request carries more
 * than the configured batch size, every row must land exactly once across
 * batch boundaries, and a failed middle batch must surface (leaving the
 * checkpoint untouched because the caller's transaction never commits).
 */

const row = (i: number): IndexedEventRow => ({
  event_identity: `evt-${i}`,
  ledger: 100 + i,
  tx_hash: `tx-${i}`,
  tx_index: i % 7,
  event_index: i,
  contract_id: 'GAAAA',
  topic: ['t'],
  value: 'v',
});

const recordingClient = (calls: { table: string; size: number; first: string }[],
                         failOnCall?: number) =>
  ({
    from(table: string) {
      return {
        upsert(rows: readonly { event_identity: string }[], _opts: object) {
          const n = calls.length;
          calls.push({ table, size: rows.length, first: rows[0]!.event_identity });
          if (n + 1 === failOnCall) {
            return Promise.resolve({ data: null, error: { message: 'payload too large' } });
          }
          return Promise.resolve({ data: rows, error: null });
        },
      };
    },
  }) as unknown as SupabaseClient;

Deno.test('upsertEvents chunks into configured batches and writes every row once', async () => {
  const calls: { table: string; size: number; first: string }[] = [];
  // batch of 3, 8 rows -> 3, 3, 2
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', recordingClient(calls), 3);
  await db.upsertEvents(Array.from({ length: 8 }, (_, i) => row(i)));

  assertEquals(calls.length, 3);
  assertEquals(calls.map((c) => c.size), [3, 3, 2]);
  assert(calls.every((c) => c.table === 'indexed_events'), 'wrong table');
  // sequential batches in input order, no row skipped or duplicated
  assertEquals(calls.map((c) => c.first), ['evt-0', 'evt-3', 'evt-6']);
});

Deno.test('a failed middle batch rejects and later rows are never sent', async () => {
  const calls: { table: string; size: number; first: string }[] = [];
  // 10 rows, batch of 2 -> 5 calls; make call #3 fail
  const db = new IndexerDb(
    'https://example.supabase.co', 'dummy-key', recordingClient(calls, 3), 2);

  await assertRejects(
    () => db.upsertEvents(Array.from({ length: 10 }, (_, i) => row(i))),
    Error,
    'payload too large',
  );
  // calls 1 and 2 landed; call 3 raised; calls 4-5 were never issued
  assertEquals(calls.length, 3);
  assertEquals(calls.map((c) => c.first), ['evt-0', 'evt-2', 'evt-4']);
});

Deno.test('persistPlan batches every fact table with the same bound', async () => {
  const calls: { table: string; size: number; first: string }[] = [];
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', recordingClient(calls), 2);
  await db.persistPlan({
    decoded: Array.from({ length: 5 }, (_, i) => row(i)) as never,
    members: [],
    contributions: [],
    payouts: [],
    fees: [],
    touchedGroups: [],
  });
  // decoded_events: 5 rows in batches of 2 -> 3 calls
  assertEquals(calls.length, 3);
  assert(calls.every((c) => c.table === 'decoded_events'), 'wrong table');
  assertEquals(calls.map((c) => c.size), [2, 2, 1]);
});
