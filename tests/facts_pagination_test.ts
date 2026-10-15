import { assert, assertEquals, assertRejects } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import { deriveGroupState } from '../supabase/functions/_shared/state.ts';

Deno.test('readGroupFacts pages through contributions exceeding PostgREST cap and derives correct total', async () => {
  const contractId = 'C0000000000000000000000000000000000000000000000000000001';
  const TOTAL_CONTRIBUTIONS = 2500;
  const CONTRIBUTION_AMOUNT = '10000000'; // 10 USDC in stroops (7 decimals)

  const mockContributions = Array.from({ length: TOTAL_CONTRIBUTIONS }, (_, i) => ({
    contract_id: contractId,
    round: (i % 10) + 1,
    amount: CONTRIBUTION_AMOUNT,
  }));

  const recordedRanges: { table: string; from: number; to: number }[] = [];

  const stubClient = {
    from(table: string) {
      return {
        select(_columns: string) {
          return {
            in(column: string, values: readonly string[]) {
              assertEquals(column, 'contract_id');
              assertEquals(values.includes(contractId), true);
              return {
                range(from: number, to: number) {
                  recordedRanges.push({ table, from, to });
                  if (table === 'contributions') {
                    const page = mockContributions.slice(from, to + 1);
                    return Promise.resolve({ data: page, error: null });
                  }
                  return Promise.resolve({ data: [], error: null });
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);

  // Read facts using default PostgREST cap of 1000
  const factsMap = await db.readGroupFacts([contractId], 1000);
  const facts = factsMap.get(contractId);
  if (!facts) throw new Error('facts missing for group');

  // Acceptance Criterion: A paged-stub test asserts all rows are read
  assertEquals(facts.contributions.length, TOTAL_CONTRIBUTIONS);

  // Range calls for contributions: 0-999, 1000-1999, 2000-2999
  const contribRanges = recordedRanges.filter((r) => r.table === 'contributions');
  assertEquals(contribRanges, [
    { table: 'contributions', from: 0, to: 999 },
    { table: 'contributions', from: 1000, to: 1999 },
    { table: 'contributions', from: 2000, to: 2999 },
  ]);

  // Acceptance Criterion: A group with more contributions than the PostgREST cap derives the correct total
  const derived = deriveGroupState(contractId, facts);
  const expectedTotal = (BigInt(TOTAL_CONTRIBUTIONS) * BigInt(CONTRIBUTION_AMOUNT)).toString();
  assertEquals(derived.contributed_total, expectedTotal);
  assertEquals(derived.contributed_total, '25000000000');
});

Deno.test('readGroupFacts chunks large contract_id list to avoid exceeding URL limits', async () => {
  const TOTAL_GROUPS = 250;
  const contractIds = Array.from(
    { length: TOTAL_GROUPS },
    (_, i) => `C${String(i).padStart(55, '0')}`,
  );

  const chunkedIdsRequested: { table: string; values: string[] }[] = [];

  const stubClient = {
    from(table: string) {
      return {
        select(_columns: string) {
          return {
            in(_column: string, values: readonly string[]) {
              chunkedIdsRequested.push({ table, values: [...values] });
              return {
                range(_from: number, _to: number) {
                  return Promise.resolve({ data: [], error: null });
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);
  await db.readGroupFacts(contractIds);

  // Each table query chunks contractIds into chunks <= 100
  // With 250 contracts: each table should see chunks of 100, 100, 50
  for (const entry of chunkedIdsRequested) {
    assertEquals(entry.values.length <= 100, true);
  }

  const memberChunks = chunkedIdsRequested
    .filter((e) => e.table === 'group_members')
    .map((e) => e.values.length);
  assertEquals(memberChunks, [100, 100, 50]);
});

Deno.test('readGroupFacts fails loudly if query hits server cap without pagination support', async () => {
  const contractId = 'C0000000000000000000000000000000000000000000000000000001';
  const stubClient = {
    from(_table: string) {
      return {
        select(_columns: string) {
          return {
            in(_column: string, _values: readonly string[]) {
              // Return 1000 rows without .range() method
              const fullCapData = Array.from({ length: 1000 }, () => ({
                contract_id: contractId,
                round: 1,
                amount: '100',
              }));
              return Promise.resolve({ data: fullCapData, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);
  await assertRejects(
    () => db.readGroupFacts([contractId], 1000),
    Error,
    'without pagination support',
  );
});

Deno.test('readGroupState pages through stored group rows exceeding page size', async () => {
  const TOTAL_GROUPS = 2500;
  const mockGroups = Array.from({ length: TOTAL_GROUPS }, (_, i) => ({
    contract_id: `C${String(i).padStart(55, '0')}`,
    status: 'open',
    member_count: 5,
    current_round: 1,
    completed_rounds: 0,
    contributed_total: '50000000',
    paid_out_total: '0',
    fee_total: '0',
    last_event_ledger: 1000,
  }));

  const recordedRanges: { from: number; to: number }[] = [];

  const stubClient = {
    from(table: string) {
      assertEquals(table, 'groups');
      return {
        select(_columns: string) {
          return {
            in(_column: string, _values: readonly string[]) {
              return {
                range(from: number, to: number) {
                  recordedRanges.push({ from, to });
                  const page = mockGroups.slice(from, to + 1);
                  return Promise.resolve({ data: page, error: null });
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);
  const contractIds = mockGroups.map((g) => g.contract_id);
  const states = await db.readGroupState(contractIds, 1000);

  assertEquals(states.size, TOTAL_GROUPS);
  assertEquals(states.get(mockGroups[0]!.contract_id)?.status, 'open');
  assertEquals(states.get(mockGroups[2499]!.contract_id)?.contributed_total, '50000000');
});

/**
 * Paging is only stable when the query carries an `ORDER BY`.
 *
 * The stub below mimics Postgres: rows come back in the order the query asked
 * for, and an unordered read falls back to the planner's arbitrary order — a
 * shuffled one here. With `pageSize` below the row count, an unordered read
 * shows a row twice on adjacent pages and drops another, which is what the
 * assertions pin down.
 */
Deno.test('readGroupFacts orders paged reads so every row is returned exactly once', async () => {
  const contractId = 'C0000000000000000000000000000000000000000000000000000001';
  const TOTAL = 2500;

  // Stored in a shuffled order: an unordered read sees this permutation, and
  // the pages slice straight into it.
  const stored = Array.from({ length: TOTAL }, (_, i) => ({
    contract_id: contractId,
    event_identity: `E${String((i * 7919) % TOTAL).padStart(5, '0')}`,
    round: (i % 10) + 1,
    amount: '1000000',
  }));

  const orderedRanges: { table: string; cols: string[]; from: number; to: number }[] = [];

  const stubClient = {
    from(table: string) {
      return {
        select(_columns: string) {
          return {
            in(_column: string, _values: readonly string[]) {
              const cols: string[] = [];
              const builder = {
                order(col: string, options: { ascending: boolean } | undefined) {
                  cols.push(col);
                  assertEquals(options?.ascending, true);
                  return builder;
                },
                range(from: number, to: number) {
                  orderedRanges.push({ table, cols: [...cols], from, to });
                  const source = cols.length > 0
                    ? [...stored].sort((a, b) => {
                      for (const col of cols) {
                        const left = String(a[col as keyof typeof a]);
                        const right = String(b[col as keyof typeof b]);
                        if (left !== right) return left < right ? -1 : 1;
                      }
                      return 0;
                    })
                    : stored;
                  return Promise.resolve({
                    data: table === 'contributions' ? source.slice(from, to + 1) : [],
                    error: null,
                  });
                },
              };
              return builder;
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);
  const factsMap = await db.readGroupFacts([contractId], 1000);
  const facts = factsMap.get(contractId);
  if (!facts) throw new Error('facts missing for group');

  // Every contribution is read exactly once across the three pages.
  assertEquals(facts.contributions.length, TOTAL);

  // Every paged read carries an ORDER BY, and it is the table's own key:
  // contract_id plus a unique tiebreaker, applied before the range.
  const contribRanges = orderedRanges.filter((r) => r.table === 'contributions');
  assertEquals(contribRanges.length, 3);
  assertEquals(contribRanges[0]?.cols, ['contract_id', 'event_identity']);
  assertEquals(contribRanges[1]?.from, 1000);
  assertEquals(contribRanges[2]?.from, 2000);
  for (const range of orderedRanges) {
    assert(range.cols.length > 0, `${range.table} is paged without an ORDER BY`);
  }

  // Derivation over the paged response is still exact: 2500 x 1000000.
  const derived = deriveGroupState(contractId, facts);
  assertEquals(derived.contributed_total, '2500000000');
});

