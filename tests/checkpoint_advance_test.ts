import { assertEquals, assertRejects } from '@std/assert';
import { type SupabaseClient } from '@supabase/supabase-js';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';

type CheckpointRow = {
  id: string;
  last_processed_ledger: number;
  start_ledger: number;
  updated_at: string;
};

function createMockSupabaseClient(initialRows: CheckpointRow[] = []): {
  client: SupabaseClient;
  rows: Map<string, CheckpointRow>;
  calls: string[];
} {
  const rows = new Map<string, CheckpointRow>();
  for (const row of initialRows) {
    rows.set(row.id, { ...row });
  }
  const calls: string[] = [];

  const client = {
    from(table: string) {
      assertEquals(table, 'indexer_checkpoints');
      return {
        update(values: Partial<CheckpointRow>) {
          calls.push('update');
          let filterId: string | null = null;
          let filterLtLedger: number | null = null;

          const queryObj = {
            eq(col: string, val: string) {
              if (col === 'id') filterId = val;
              return queryObj;
            },
            lt(col: string, val: number) {
              if (col === 'last_processed_ledger') filterLtLedger = val;
              return queryObj;
            },
            select(_cols?: string) {
              calls.push('select');
              const matched: CheckpointRow[] = [];
              if (filterId && rows.has(filterId)) {
                const current = rows.get(filterId)!;
                if (filterLtLedger === null || current.last_processed_ledger < filterLtLedger) {
                  const updated: CheckpointRow = {
                    ...current,
                    ...values,
                    last_processed_ledger: Number(
                      values.last_processed_ledger ?? current.last_processed_ledger,
                    ),
                    start_ledger: Number(values.start_ledger ?? current.start_ledger),
                    updated_at: String(values.updated_at ?? current.updated_at),
                  };
                  rows.set(filterId, updated);
                  matched.push(updated);
                }
              }
              return Promise.resolve({ data: matched, error: null });
            },
            then(resolve: (res: { data: unknown; error: unknown }) => void) {
              // Supports direct await without .select()
              const matched: CheckpointRow[] = [];
              if (filterId && rows.has(filterId)) {
                const current = rows.get(filterId)!;
                if (filterLtLedger === null || current.last_processed_ledger < filterLtLedger) {
                  const updated: CheckpointRow = {
                    ...current,
                    ...values,
                    last_processed_ledger: Number(
                      values.last_processed_ledger ?? current.last_processed_ledger,
                    ),
                    start_ledger: Number(values.start_ledger ?? current.start_ledger),
                    updated_at: String(values.updated_at ?? current.updated_at),
                  };
                  rows.set(filterId, updated);
                  matched.push(updated);
                }
              }
              resolve({ data: matched, error: null });
            },
          };
          return queryObj;
        },
        upsert(
          values: CheckpointRow,
          options?: { onConflict?: string; ignoreDuplicates?: boolean },
        ) {
          calls.push('upsert');
          const conflictCol = options?.onConflict ?? 'id';
          const key = values[conflictCol as keyof CheckpointRow] as string;

          if (rows.has(key)) {
            if (options?.ignoreDuplicates) {
              // ON CONFLICT DO NOTHING
              return Promise.resolve({ data: null, error: null });
            }
            // Overwrite if not ignoring duplicates
            rows.set(key, { ...values });
            return Promise.resolve({ data: null, error: null });
          }

          rows.set(key, { ...values });
          return Promise.resolve({ data: null, error: null });
        },
        select(cols: string) {
          calls.push(`select:${cols}`);
          let filterId: string | null = null;
          const selectObj = {
            eq(col: string, val: string) {
              if (col === 'id') filterId = val;
              return selectObj;
            },
            maybeSingle() {
              if (filterId && rows.has(filterId)) {
                return Promise.resolve({ data: { ...rows.get(filterId)! }, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            },
          };
          return selectObj;
        },
      };
    },
  } as unknown as SupabaseClient;

  return { client, rows, calls };
}

Deno.test('advanceCheckpoint creates initial checkpoint when no row exists', async () => {
  const { client, rows } = createMockSupabaseClient([]);
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', client);

  await db.advanceCheckpoint({
    lastProcessedLedger: 1000,
    startLedger: 500,
  });

  const checkpoint = await db.getCheckpoint();
  assertEquals(checkpoint?.lastProcessedLedger, 1000);
  assertEquals(checkpoint?.startLedger, 500);
  assertEquals(rows.get('default')?.last_processed_ledger, 1000);
});

Deno.test('advanceCheckpoint updates checkpoint when new ledger is strictly greater', async () => {
  const { client, rows } = createMockSupabaseClient([
    {
      id: 'default',
      last_processed_ledger: 1000,
      start_ledger: 500,
      updated_at: '2026-08-01T00:00:00.000Z',
    },
  ]);
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', client);

  await db.advanceCheckpoint({
    lastProcessedLedger: 1200,
    startLedger: 500,
  });

  const checkpoint = await db.getCheckpoint();
  assertEquals(checkpoint?.lastProcessedLedger, 1200);
  assertEquals(rows.get('default')?.last_processed_ledger, 1200);
});

Deno.test('advanceCheckpoint is a no-op when new ledger is lower than stored checkpoint', async () => {
  const { client, rows } = createMockSupabaseClient([
    {
      id: 'default',
      last_processed_ledger: 1500,
      start_ledger: 500,
      updated_at: '2026-08-01T00:00:00.000Z',
    },
  ]);
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', client);

  // Attempt to regress checkpoint to 1200
  await db.advanceCheckpoint({
    lastProcessedLedger: 1200,
    startLedger: 500,
  });

  const checkpoint = await db.getCheckpoint();
  assertEquals(checkpoint?.lastProcessedLedger, 1500);
  assertEquals(rows.get('default')?.last_processed_ledger, 1500);
});

Deno.test('advanceCheckpoint is a no-op when new ledger is equal to stored checkpoint', async () => {
  const { client, rows } = createMockSupabaseClient([
    {
      id: 'default',
      last_processed_ledger: 1500,
      start_ledger: 500,
      updated_at: '2026-08-01T00:00:00.000Z',
    },
  ]);
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', client);

  // Replay of same ledger 1500
  await db.advanceCheckpoint({
    lastProcessedLedger: 1500,
    startLedger: 500,
  });

  const checkpoint = await db.getCheckpoint();
  assertEquals(checkpoint?.lastProcessedLedger, 1500);
  assertEquals(rows.get('default')?.last_processed_ledger, 1500);
});

Deno.test('two runs writing in reverse order leave the higher ledger', async () => {
  const { client, rows } = createMockSupabaseClient([]);
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', client);

  // Run 1 processes a later range and writes ledger 2000 first
  await db.advanceCheckpoint({
    lastProcessedLedger: 2000,
    startLedger: 100,
  });
  assertEquals(rows.get('default')?.last_processed_ledger, 2000);

  // Run 2 processes an earlier range (or out-of-order run) and attempts to write ledger 1000
  await db.advanceCheckpoint({
    lastProcessedLedger: 1000,
    startLedger: 100,
  });

  // The database retains the higher ledger 2000
  const checkpoint = await db.getCheckpoint();
  assertEquals(checkpoint?.lastProcessedLedger, 2000);
  assertEquals(rows.get('default')?.last_processed_ledger, 2000);
});

Deno.test('two runs writing in forward order advance correctly', async () => {
  const { client, rows } = createMockSupabaseClient([]);
  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', client);

  // Run 1 writes ledger 1000
  await db.advanceCheckpoint({
    lastProcessedLedger: 1000,
    startLedger: 100,
  });
  assertEquals(rows.get('default')?.last_processed_ledger, 1000);

  // Run 2 writes ledger 2000
  await db.advanceCheckpoint({
    lastProcessedLedger: 2000,
    startLedger: 100,
  });

  // Checkpoint advanced to 2000
  const checkpoint = await db.getCheckpoint();
  assertEquals(checkpoint?.lastProcessedLedger, 2000);
  assertEquals(rows.get('default')?.last_processed_ledger, 2000);
});

Deno.test('advanceCheckpoint propagates database update errors', async () => {
  const failingClient = {
    from(_table: string) {
      return {
        update(_values: unknown) {
          return {
            eq(_col: string, _val: unknown) {
              return {
                lt(_col: string, _val: unknown) {
                  return {
                    select(_cols?: string) {
                      return Promise.resolve({
                        data: null,
                        error: { message: 'connection failure' },
                      });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;

  const db = new IndexerDb('https://example.supabase.co', 'dummy-key', failingClient);

  await assertRejects(
    () =>
      db.advanceCheckpoint({
        lastProcessedLedger: 1000,
        startLedger: 100,
      }),
    Error,
    'Failed to advance indexer checkpoint: connection failure',
  );
});
