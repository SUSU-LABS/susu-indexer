import { assertEquals, assertRejects } from '@std/assert';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
type Call = { table: string; ids: string[]; orders: string[]; from: number; to: number };

/**
 * A PostgREST stand-in that honours `.in()`, `.order()` and `.range()` and records
 * every request, so a test can assert both what was read and how it was asked for.
 */
function stubClient(tables: Record<string, Row[]>, failTable?: string) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => ({
      select: () => ({
        in: (_column: string, ids: string[]) => {
          const orders: string[] = [];
          const query = {
            order: (column: string) => {
              orders.push(column);
              return query;
            },
            range: (from: number, to: number) => {
              calls.push({ table, ids, orders: [...orders], from, to });
              if (table === failTable) {
                return Promise.resolve({ data: null, error: { message: 'boom' } });
              }
              const rows = (tables[table] ?? []).filter((r) =>
                ids.includes(String(r['contract_id']))
              );
              return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
            },
          };
          return query;
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

const contributions = (count: number, contractId = 'C0001'): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    contract_id: contractId,
    round: 1,
    amount: '10',
    event_identity: `${contractId}:${i}`,
  }));

const readFacts = (client: SupabaseClient, ids: string[]) =>
  new IndexerDb('https://example.supabase.co', 'dummy-key', client).readGroupFacts(ids);

Deno.test('readGroupFacts pages through more contributions than the server cap', async () => {
  const total = 2500;
  const { client, calls } = stubClient({ contributions: contributions(total) });

  const facts = await readFacts(client, ['C0001']);

  assertEquals(facts.get('C0001')?.contributions.length, total);
  assertEquals(
    calls.filter((c) => c.table === 'contributions').map(({ from, to }) => ({ from, to })),
    [{ from: 0, to: 999 }, { from: 1000, to: 1999 }, { from: 2000, to: 2999 }],
  );
});

Deno.test('readGroupFacts orders by a total key so pages cannot skip or repeat rows', async () => {
  const { client, calls } = stubClient({ contributions: contributions(3) });

  await readFacts(client, ['C0001']);

  const orderOf = (table: string) => calls.find((c) => c.table === table)?.orders;
  assertEquals(orderOf('contributions'), ['contract_id', 'event_identity']);
  assertEquals(orderOf('payouts'), ['contract_id', 'event_identity']);
  assertEquals(orderOf('protocol_fees'), ['contract_id', 'event_identity']);
  assertEquals(orderOf('decoded_events'), ['contract_id', 'event_identity']);
  assertEquals(orderOf('group_members'), ['contract_id', 'member']);
});

Deno.test('readGroupFacts splits a long contract id list into several requests', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `C${String(i).padStart(4, '0')}`);
  const rows = ids.flatMap((id) => contributions(2, id));
  const { client, calls } = stubClient({ contributions: rows });

  const facts = await readFacts(client, ids);

  assertEquals(calls.filter((c) => c.table === 'contributions').map((c) => c.ids.length), [
    100,
    100,
    50,
  ]);
  assertEquals(facts.size, 250);
  assertEquals(facts.get('C0249')?.contributions.length, 2);
});

Deno.test('readGroupFacts loses nothing when the row count is an exact multiple of the page size', async () => {
  const { client, calls } = stubClient({ contributions: contributions(1000) });

  const facts = await readFacts(client, ['C0001']);

  assertEquals(facts.get('C0001')?.contributions.length, 1000);
  // A full page cannot prove the end, so one more (empty) page is requested.
  assertEquals(calls.filter((c) => c.table === 'contributions').length, 2);
});

Deno.test('readGroupFacts fails loudly when a page read fails instead of returning partial facts', async () => {
  const { client } = stubClient({ contributions: contributions(2500) }, 'contributions');

  await assertRejects(
    () => readFacts(client, ['C0001']),
    Error,
    'Failed to read contributions: boom',
  );
});
