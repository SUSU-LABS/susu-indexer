import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import type { GroupState } from '../supabase/functions/_shared/state.ts';

type RpcCall = { fn: string; params: Record<string, unknown> };

/**
 * A Supabase client stub that only implements `rpc`, and counts calls.
 * `onRpc` returns `{ data }` on success or `{ error: { message } }`.
 */
function mockClient(
  onRpc: (
    fn: string,
    params: Record<string, unknown>,
  ) => { data: unknown; error: null } | { data: null; error: { message: string } },
): { client: SupabaseClient; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const client = {
    rpc: (fn: string, params: Record<string, unknown>) => {
      calls.push({ fn, params });
      return Promise.resolve(onRpc(fn, params));
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

function makeState(contractId: string, overrides: Partial<GroupState> = {}): GroupState {
  return {
    contract_id: contractId,
    status: 'active',
    member_count: 3,
    current_round: 2,
    completed_rounds: 1,
    contributed_total: '300',
    paid_out_total: '100',
    fee_total: '5',
    last_event_ledger: 42,
    ...overrides,
  };
}

function makeDb(
  onRpc: Parameters<typeof mockClient>[0],
): { db: IndexerDb; calls: RpcCall[] } {
  const { client, calls } = mockClient(onRpc);
  const db = new IndexerDb('https://example.supabase.co', 'service-role-key', client);
  return { db, calls };
}

Deno.test('upsertGroupState issues a single RPC for N groups', async () => {
  const states = Array.from({ length: 7 }, (_, i) => makeState(`contract-${i}`));
  let seenPayload: unknown[] = [];
  const { db, calls } = makeDb((_fn, params) => {
    seenPayload = params.p_states as unknown[];
    return { data: [], error: null };
  });

  await db.upsertGroupState(states);

  assertEquals(calls.length, 1);
  assertEquals(calls[0]?.fn, 'reconcile_group_states');
  assertEquals(seenPayload.length, 7);
  const ids = seenPayload.map((row) => (row as { contract_id: string }).contract_id).sort();
  assertEquals(ids, states.map((s) => s.contract_id).sort());
  // Every row carries the derived figures and an updated_at stamp.
  for (const row of seenPayload as Record<string, unknown>[]) {
    assertEquals(typeof row['updated_at'], 'string');
    assertEquals(row['status'], 'active');
    assertEquals(row['contributed_total'], '300');
  }
});

Deno.test('upsertGroupState with no states issues no request', async () => {
  const { db, calls } = makeDb(() => {
    throw new Error('must not be called');
  });

  await db.upsertGroupState([]);

  assertEquals(calls.length, 0);
});

Deno.test('upsertGroupState fails loudly when a group has no row', async () => {
  const states = [makeState('exists-1'), makeState('ghost-9'), makeState('exists-2')];
  const { db, calls } = makeDb(() => ({ data: ['ghost-9'], error: null }));

  const err = await assertRejects(() => db.upsertGroupState(states), Error);
  assertStringIncludes(err.message, 'ghost-9');
  assertStringIncludes(err.message, 'no groups row');
  assertEquals(calls.length, 1);
});

Deno.test('upsertGroupState surfaces an RPC transport error', async () => {
  const { db } = makeDb(() => ({
    data: null,
    error: { message: 'connection reset' },
  }));

  const err = await assertRejects(() => db.upsertGroupState([makeState('c1')]), Error);
  assertStringIncludes(err.message, 'Failed to record group state');
  assertStringIncludes(err.message, 'connection reset');
});

Deno.test('upsertGroupState dedupes repeated contract ids, last wins', async () => {
  let seenPayload: Record<string, unknown>[] = [];
  const { db, calls } = makeDb((_fn, params) => {
    seenPayload = params.p_states as Record<string, unknown>[];
    return { data: [], error: null };
  });

  await db.upsertGroupState([
    makeState('dup', { member_count: 1 }),
    makeState('other'),
    makeState('dup', { member_count: 5 }),
  ]);

  assertEquals(calls.length, 1);
  assertEquals(seenPayload.length, 2);
  const dup = seenPayload.find((r) => r['contract_id'] === 'dup');
  assert(dup !== undefined);
  assertEquals(dup['member_count'], 5);
});
