import { assertEquals, assertRejects } from '@std/assert';
import { IndexerDb, WRITE_BATCH_SIZE } from '../supabase/functions/_shared/db.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A stub client that records every upsert body it is handed.
 *
 * `failAt` makes one chosen batch reject, which is how the middle-batch case is
 * exercised without a real database.
 */
function stubClient(
  failAt = -1,
): { bodies: object[][]; client: SupabaseClient } {
  const bodies: object[][] = [];
  let calls = 0;

  const client = {
    from: (_table: string) => ({
      upsert: (rows: object[], _options: unknown) => {
        calls++;
        bodies.push(rows);
        const error = calls === failAt ? { message: 'batch refused' } : null;
        return Promise.resolve({ data: null, error });
      },
    }),
  } as unknown as SupabaseClient;

  return { bodies, client };
}

function eventRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    event_identity: `e${i}`,
    ledger: 1000 + (i % 50),
    tx_hash: `h${i}`,
    tx_index: i,
    event_index: i,
    contract_id: 'CFACTORY',
    topic: ['joined'],
    value: '1',
  }));
}

Deno.test('upsertEvents splits a large range into bounded batches', async () => {
  const { bodies, client } = stubClient();
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', client);

  await db.upsertEvents(eventRows(WRITE_BATCH_SIZE * 2 + 7));

  assertEquals(bodies.length, 3);
  for (const body of bodies) {
    assertEquals(body.length <= WRITE_BATCH_SIZE, true);
  }
  assertEquals(bodies.map((body) => body.length), [WRITE_BATCH_SIZE, WRITE_BATCH_SIZE, 7]);
});

Deno.test('every row is written exactly once across batch boundaries', async () => {
  const { bodies, client } = stubClient();
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', client);

  await db.upsertEvents(eventRows(WRITE_BATCH_SIZE + 3));

  const identities = bodies.flat().map((row) => (row as { event_identity: string }).event_identity);
  assertEquals(identities.length, WRITE_BATCH_SIZE + 3);
  assertEquals(new Set(identities).size, WRITE_BATCH_SIZE + 3);
  assertEquals(identities[0], 'e0');
  assertEquals(identities[identities.length - 1], `e${WRITE_BATCH_SIZE + 2}`);
});

Deno.test('a refused middle batch fails the whole write', async () => {
  const { bodies, client } = stubClient(2);
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', client);

  await assertRejects(
    () => db.upsertEvents(eventRows(WRITE_BATCH_SIZE + 3)),
    Error,
    'batch refused',
  );

  // The failure surfaces at the second batch, so the third is never attempted.
  assertEquals(bodies.length, 2);
});

Deno.test('persistPlan batches each fact table separately', async () => {
  const { bodies, client } = stubClient();
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', client);

  await db.persistPlan({
    decoded: eventRows(WRITE_BATCH_SIZE + 1),
    members: [{ contract_id: 'CGROUP', member: 'M1', position: 1 }],
    contributions: [],
    payouts: [],
    fees: [],
    touchedGroups: ['CGROUP'],
  } as never);

  // Two batches for the oversized table, one for the single group member. The
  // three empty fact tables are skipped without a request.
  assertEquals(bodies.map((body) => body.length), [WRITE_BATCH_SIZE, 1, 1]);
});

Deno.test('upsertGroups splits a large watch list', async () => {
  const { bodies, client } = stubClient();
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', client);

  const groups = Array.from({ length: WRITE_BATCH_SIZE + 2 }, (_, i) => ({
    contract_id: `C${i}`,
    factory_contract_id: 'CFACTORY',
    group_id: i,
    creator: 'GCREATOR',
    token: 'CTOKEN',
    contribution_amount: '100',
    member_capacity: 3,
    created_ledger: 1000 + i,
  }));
  await db.upsertGroups(groups);

  assertEquals(bodies.map((body) => body.length), [WRITE_BATCH_SIZE, 2]);
});
