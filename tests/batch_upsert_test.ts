/**
 * Batched upsert tests.
 *
 * The property under test: no single PostgREST request carries more than
 * UPSERT_BATCH_SIZE rows, every row is written exactly once across batch
 * boundaries, and a failed middle batch fails the run (so the checkpoint is
 * left untouched and the range is retried whole).
 */

import { assertEquals, assertRejects } from '@std/assert';
import {
  type IndexedEventRow,
  IndexerDb,
  UPSERT_BATCH_SIZE,
} from '../supabase/functions/_shared/db.ts';
import type { NewGroup } from '../supabase/functions/_shared/discovery.ts';

type UpsertCall = { table: string; rows: object[] };

/**
 * A Supabase client stub that records every upsert call.
 *
 * `failOnCall` makes the Nth upsert (0-based) return an error, simulating a
 * failed middle batch.
 */
function stubClient(opts: { failOnCall?: number } = {}) {
  const calls: UpsertCall[] = [];
  let n = 0;
  const client = {
    from(table: string) {
      return {
        upsert(rows: object[], _opts: unknown) {
          const callIndex = n++;
          calls.push({ table, rows: [...rows] });
          if (opts.failOnCall === callIndex) {
            return Promise.resolve({ data: null, error: { message: 'boom' } });
          }
          return Promise.resolve({ data: rows, error: null });
        },
      };
    },
  };
  // deno-lint-ignore no-explicit-any
  return { client: client as any, calls };
}

function eventRow(i: number): IndexedEventRow {
  return {
    event_identity: `ev-${i}`,
    ledger: 1000 + i,
    tx_hash: 'a'.repeat(64),
    tx_index: 0,
    event_index: i,
    contract_id: `C${'A'.repeat(55)}`,
    topic: [],
    value: '',
  };
}

function group(i: number): NewGroup {
  return {
    contract_id: `C${String(i).padStart(55, '0')}`,
    factory_contract_id: `C${'F'.repeat(55)}`,
    group_id: i,
    creator: `G${'C'.repeat(55)}`,
    token: `C${'T'.repeat(55)}`,
    contribution_amount: '100',
    member_capacity: 10,
    created_ledger: 1000,
  };
}

Deno.test('upsertEvents chunks into bounded batches', async () => {
  const { client, calls } = stubClient();
  const db = new IndexerDb('https://x.test', 'key', client);

  const total = UPSERT_BATCH_SIZE * 2 + 37;
  await db.upsertEvents(Array.from({ length: total }, (_, i) => eventRow(i)));

  assertEquals(calls.length, 3);
  assertEquals(calls[0]!.table, 'indexed_events');
  for (const call of calls) {
    assertEquals(call.rows.length <= UPSERT_BATCH_SIZE, true);
  }
  // Every row written exactly once, in order.
  const identities = calls.flatMap((c) =>
    (c.rows as IndexedEventRow[]).map((r) => r.event_identity)
  );
  assertEquals(identities.length, total);
  assertEquals(new Set(identities).size, total);
  assertEquals(identities[0], 'ev-0');
  assertEquals(identities[total - 1], `ev-${total - 1}`);
});

Deno.test('upsertEvents with fewer rows than a batch issues one request', async () => {
  const { client, calls } = stubClient();
  const db = new IndexerDb('https://x.test', 'key', client);

  await db.upsertEvents([eventRow(0), eventRow(1)]);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.rows.length, 2);
});

Deno.test('upsertEvents with no rows issues no request', async () => {
  const { client, calls } = stubClient();
  const db = new IndexerDb('https://x.test', 'key', client);

  await db.upsertEvents([]);
  assertEquals(calls.length, 0);
});

Deno.test('upsertGroups batches like upsertEvents', async () => {
  const { client, calls } = stubClient();
  const db = new IndexerDb('https://x.test', 'key', client);

  const total = UPSERT_BATCH_SIZE + 1;
  await db.upsertGroups(Array.from({ length: total }, (_, i) => group(i)));

  assertEquals(calls.length, 2);
  assertEquals(calls[0]!.table, 'groups');
  assertEquals(calls[0]!.rows.length, UPSERT_BATCH_SIZE);
  assertEquals(calls[1]!.rows.length, 1);
});

Deno.test('a failed middle batch fails the run', async () => {
  const { client, calls } = stubClient({ failOnCall: 1 });
  const db = new IndexerDb('https://x.test', 'key', client);

  const total = UPSERT_BATCH_SIZE * 2;
  const err = await assertRejects(() =>
    db.upsertEvents(Array.from({ length: total }, (_, i) => eventRow(i)))
  );
  assertEquals((err as Error).message.includes('indexed_events'), true);
  // The third batch never ran: the failure propagated immediately.
  assertEquals(calls.length, 2);
});

Deno.test('persistPlan batches each table', async () => {
  const { client, calls } = stubClient();
  const db = new IndexerDb('https://x.test', 'key', client);

  const n = UPSERT_BATCH_SIZE + 5;
  const decoded = Array.from({ length: n }, (_, i) => ({
    event_identity: `d-${i}`,
    name: 'contribution',
    contract_id: `C${'A'.repeat(55)}`,
    ledger: 1,
    tx_hash: 'a'.repeat(64),
    tx_index: 0,
    event_index: i,
    event_id: `0000000000000000001-${String(i).padStart(10, '0')}`,
    payload: {},
  }));
  const contributions = Array.from({ length: n }, (_, i) => ({
    event_identity: `c-${i}`,
    contract_id: `C${'A'.repeat(55)}`,
    member: `G${'B'.repeat(55)}`,
    round: 1,
    amount: '100',
    ledger: 1,
    tx_hash: 'a'.repeat(64),
  }));
  await db.persistPlan({
    decoded,
    members: [],
    contributions,
    payouts: [],
    fees: [],
    touchedGroups: [],
  });

  const byTable = new Map<string, number>();
  for (const c of calls) {
    byTable.set(c.table, (byTable.get(c.table) ?? 0) + c.rows.length);
    assertEquals(c.rows.length <= UPSERT_BATCH_SIZE, true);
  }
  assertEquals(byTable.get('decoded_events'), n);
  assertEquals(byTable.get('contributions'), n);
  // Empty tables issue no requests.
  assertEquals(calls.some((c) => c.table === 'payouts'), false);
});
