import { assertEquals, assertRejects } from '@std/assert';
import { type SupabaseClient } from '@supabase/supabase-js';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';

Deno.test('listGroupContractIds returns all groups when table exceeds 1000 groups', async () => {
  const TOTAL_GROUPS = 2500;
  const mockTable = Array.from({ length: TOTAL_GROUPS }, (_, i) => ({
    contract_id: `C${String(i).padStart(55, '0')}`,
  }));

  const recordedRanges: { from: number; to: number }[] = [];

  const stubClient = {
    from(table: string) {
      assertEquals(table, 'groups');
      return {
        select(columns: string) {
          assertEquals(columns, 'contract_id');
          return {
            order(col: string) {
              assertEquals(col, 'contract_id');
              return this;
            },
            range(from: number, to: number) {
              recordedRanges.push({ from, to });
              // Slice the table like Postgres range
              const page = mockTable.slice(from, to + 1);
              return Promise.resolve({ data: page, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);

  const result = await db.listGroupContractIds();

  // All 2500 groups returned, none dropped
  assertEquals(result.length, TOTAL_GROUPS);
  assertEquals(result[0], `C${'0'.repeat(55)}`);
  assertEquals(result[TOTAL_GROUPS - 1], `C${String(TOTAL_GROUPS - 1).padStart(55, '0')}`);

  // Asserts pagination occurs across multiple pages
  assertEquals(recordedRanges, [
    { from: 0, to: 999 },
    { from: 1000, to: 1999 },
    { from: 2000, to: 2999 },
  ]);
});

Deno.test('listGroupContractIds handles table with exact page boundary', async () => {
  const TOTAL_GROUPS = 1000;
  const mockTable = Array.from({ length: TOTAL_GROUPS }, (_, i) => ({
    contract_id: `C${String(i).padStart(55, '0')}`,
  }));

  const recordedRanges: { from: number; to: number }[] = [];

  const stubClient = {
    from(table: string) {
      assertEquals(table, 'groups');
      return {
        select(columns: string) {
          assertEquals(columns, 'contract_id');
          return {
            order() {
              return this;
            },
            range(from: number, to: number) {
              recordedRanges.push({ from, to });
              const page = mockTable.slice(from, to + 1);
              return Promise.resolve({ data: page, error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);

  const result = await db.listGroupContractIds();

  assertEquals(result.length, TOTAL_GROUPS);
  assertEquals(recordedRanges, [
    { from: 0, to: 999 },
    { from: 1000, to: 1999 },
  ]);
});

Deno.test('listGroupContractIds handles fewer groups than page size without extra calls', async () => {
  const TOTAL_GROUPS = 42;
  const mockTable = Array.from({ length: TOTAL_GROUPS }, (_, i) => ({
    contract_id: `C${String(i).padStart(55, '0')}`,
  }));

  const recordedRanges: { from: number; to: number }[] = [];

  const stubClient = {
    from() {
      return {
        select() {
          return {
            range(from: number, to: number) {
              recordedRanges.push({ from, to });
              return Promise.resolve({ data: mockTable.slice(from, to + 1), error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);

  const result = await db.listGroupContractIds();

  assertEquals(result.length, TOTAL_GROUPS);
  assertEquals(recordedRanges, [{ from: 0, to: 999 }]);
});

Deno.test('listGroupContractIds handles empty table', async () => {
  const stubClient = {
    from() {
      return {
        select() {
          return {
            range() {
              return Promise.resolve({ data: [], error: null });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);

  const result = await db.listGroupContractIds();
  assertEquals(result, []);
});

Deno.test('listGroupContractIds propagates query errors', async () => {
  const stubClient = {
    from() {
      return {
        select() {
          return {
            range() {
              return Promise.resolve({ data: null, error: { message: 'table locked' } });
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', stubClient);

  await assertRejects(
    () => db.listGroupContractIds(),
    Error,
    'Failed to read indexed group contracts: table locked',
  );
});
