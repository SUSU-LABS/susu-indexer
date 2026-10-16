import { assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import { deriveGroupState } from '../supabase/functions/_shared/state.ts';

/**
 * Acceptance tests for SUSU-LABS/susu-indexer#37
 * ("[Bounty: $80] Add a stable ORDER BY to #selectIn before paging").
 *
 * PostgREST without ORDER BY does not guarantee stable rows across
 * OFFSET/LIMIT pages under concurrent writes, so the paged #selectIn
 * readers (readGroupFacts / readGroupState) could silently skip or
 * double-count rows once a group's facts exceed the page size (1000).
 */

// Deterministic PRNG so the "shuffled" pages are reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CONTRACT_ID = 'C0000000000000000000000000000000000000000000000000000001';

// The stable ORDER BY each #selectIn table must carry (contract_id first,
// then the per-table tiebreaker), mirroring SELECT_IN_ORDERS in db.ts.
const EXPECTED_ORDERS: Record<string, string[]> = {
  group_members: ['contract_id', 'position'],
  contributions: ['contract_id', 'round', 'member'],
  payouts: ['contract_id', 'round'],
  protocol_fees: ['contract_id', 'round'],
  decoded_events: ['contract_id', 'event_identity'],
  groups: ['contract_id'],
};

/** Builds a stub client that records order/range calls and serves pages from shuffled rows. */
function buildStub(
  rowsByTable: Record<string, Record<string, unknown>[]>,
  recorded: {
    orders: { table: string; columns: string[] }[];
    ranges: { table: string; from: number; to: number }[];
  },
) {
  return {
    from(table: string) {
      const orders: string[] = [];
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.in = () => chain;
      chain.order = (col: string, _opts: { ascending: boolean }) => {
        orders.push(col);
        return chain;
      };
      chain.range = (from: number, to: number) => {
        recorded.orders.push({ table, columns: [...orders] });
        recorded.ranges.push({ table, from, to });
        const page = (rowsByTable[table] ?? []).slice(from, to + 1);
        return Promise.resolve({ data: page, error: null });
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

Deno.test('every #selectIn table orders deterministically before paging', async () => {
  const recorded = {
    orders: [] as { table: string; columns: string[] }[],
    ranges: [] as { table: string; from: number; to: number }[],
  };
  const db = new IndexerDb(
    'https://example.supabase.co',
    'dummy-key',
    buildStub({ groups: [{ contract_id: CONTRACT_ID }] }, recorded),
  );

  await db.readGroupFacts([CONTRACT_ID]);
  await db.readGroupState([CONTRACT_ID]);

  const ordersByTable = new Map<string, string[][]>();
  for (const entry of recorded.orders) {
    const list = ordersByTable.get(entry.table) ?? [];
    list.push(entry.columns);
    ordersByTable.set(entry.table, list);
  }

  for (const [table, expected] of Object.entries(EXPECTED_ORDERS)) {
    const calls = ordersByTable.get(table);
    assertEquals(Array.isArray(calls) && calls.length > 0, true, `${table} ran at least one ordered page`);
    for (const columns of calls!) {
      assertEquals(columns, expected, `${table} order columns`);
    }
  }

  // Order is applied once per range call, and before it.
  assertEquals(recorded.orders.length, recorded.ranges.length);
});

Deno.test('paged stub with >1000 shuffled rows returns every row exactly once', async () => {
  const TOTAL = 2500;

  const rand = mulberry32(37);
  // Distinct amount per row so a skip or double shows up in the set and sum.
  const contributions = Array.from({ length: TOTAL }, (_, i) => ({
    contract_id: CONTRACT_ID,
    round: (i % 10) + 1,
    member: `m${i}`,
    amount: String((i + 1) * 1000),
  }));
  // Simulate the unstable page contents of an unordered PostgREST: the full
  // row set exists but arrives in shuffled slices.
  for (let i = contributions.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = contributions[i]!;
    contributions[i] = contributions[j]!;
    contributions[j] = tmp;
  }
  const expectedTotal = contributions
    .map((c) => BigInt(c.amount))
    .reduce((a, b) => a + b, 0n)
    .toString();

  const recorded = {
    orders: [] as { table: string; columns: string[] }[],
    ranges: [] as { table: string; from: number; to: number }[],
  };
  const db = new IndexerDb(
    'https://example.supabase.co',
    'dummy-key',
    buildStub({ contributions }, recorded),
  );

  const factsMap = await db.readGroupFacts([CONTRACT_ID], 1000);
  const facts = factsMap.get(CONTRACT_ID);
  if (!facts) throw new Error('facts missing for group');

  // Every row exactly once: 2500 rows, 2500 distinct amounts, exact sum.
  assertEquals(facts.contributions.length, TOTAL);
  assertEquals(new Set(facts.contributions.map((c) => c.amount)).size, TOTAL);
  assertEquals(
    facts.contributions.map((c) => BigInt(c.amount)).reduce((a, b) => a + b, 0n).toString(),
    expectedTotal,
  );

  // Paged in 1000-row slices.
  const contribRanges = recorded.ranges.filter((r) => r.table === 'contributions');
  assertEquals(contribRanges, [
    { table: 'contributions', from: 0, to: 999 },
    { table: 'contributions', from: 1000, to: 1999 },
    { table: 'contributions', from: 2000, to: 2999 },
  ]);

  // Fact derivation is correct on the paged response.
  const derived = deriveGroupState(CONTRACT_ID, facts);
  assertEquals(derived.contributed_total, expectedTotal);
});

Deno.test('readGroupState keeps its stable order on paged group rows', async () => {
  const TOTAL = 2500;
  const rows = Array.from({ length: TOTAL }, (_, i) => ({
    contract_id: `C${String(i).padStart(55, '0')}`,
    status: 'open',
    member_count: 5,
    current_round: 1,
    completed_rounds: 0,
    contributed_total: '50000000',
    paid_out_total: '0',
    fee_total: '0',
    last_event_ledger: 100,
  }));

  const recorded = {
    orders: [] as { table: string; columns: string[] }[],
    ranges: [] as { table: string; from: number; to: number }[],
  };
  const db = new IndexerDb(
    'https://example.supabase.co',
    'dummy-key',
    buildStub({ groups: rows }, recorded),
  );

  const states = await db.readGroupState([CONTRACT_ID], 1000);

  assertEquals(states.size, TOTAL);
  for (const order of recorded.orders) {
    assertEquals(order.columns, ['contract_id']);
  }
  assertEquals(
    recorded.ranges.map((r) => [r.from, r.to]),
    [
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ],
  );
});
