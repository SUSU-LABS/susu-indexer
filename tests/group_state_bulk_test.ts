import { assert, assertEquals, assertRejects, assertStringIncludes } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PGlite } from 'npm:@electric-sql/pglite@0.5.8';
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

const MIGRATION_URL = new URL(
  '../supabase/migrations/20261010000001_reconcile_group_states.sql',
  import.meta.url,
);

const GROUPS_SCHEMA = `
create table public.groups (
  contract_id text primary key,
  factory_contract_id text not null,
  group_id bigint not null check (group_id > 0),
  creator text not null,
  token text not null,
  contribution_amount numeric(39,0) not null check (contribution_amount > 0),
  member_capacity integer not null check (member_capacity > 0),
  created_ledger bigint not null check (created_ledger >= 0),
  status text not null default 'open' check (status in ('open', 'active', 'completed')),
  member_count integer not null default 0 check (member_count >= 0),
  current_round integer not null default 0 check (current_round >= 0),
  completed_rounds integer not null default 0 check (completed_rounds >= 0),
  contributed_total numeric(39,0) not null default 0 check (contributed_total >= 0),
  paid_out_total numeric(39,0) not null default 0 check (paid_out_total >= 0),
  fee_total numeric(39,0) not null default 0 check (fee_total >= 0),
  last_event_ledger bigint not null default 0 check (last_event_ledger >= 0),
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
`;

async function freshPglite(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(GROUPS_SCHEMA);
  await db.exec('create role service_role nologin;');
  await db.exec(await Deno.readTextFile(MIGRATION_URL));
  return db;
}

Deno.test('PGlite: reconcile_group_states updates existing rows and returns missing ids', async () => {
  const pg = await freshPglite();
  try {
    await pg.query(
      `insert into public.groups (
        contract_id, factory_contract_id, group_id, creator, token,
        contribution_amount, member_capacity, created_ledger
      ) values
        ('C_EXISTS_1', 'F1', 1, 'addr1', 'USDC', 100, 5, 10),
        ('C_EXISTS_2', 'F1', 2, 'addr2', 'USDC', 200, 5, 20);`,
    );

    const res = await pg.query<{ reconcile_group_states: string[] }>(
      `select public.reconcile_group_states($1::jsonb) as reconcile_group_states;`,
      [
        JSON.stringify([
          {
            contract_id: 'C_EXISTS_1',
            status: 'active',
            member_count: 4,
            current_round: 1,
            completed_rounds: 0,
            contributed_total: '400',
            paid_out_total: '0',
            fee_total: '0',
            last_event_ledger: 100,
            updated_at: new Date().toISOString(),
          },
          {
            contract_id: 'C_MISSING_1',
            status: 'completed',
            member_count: 5,
            current_round: 5,
            completed_rounds: 5,
            contributed_total: '2500',
            paid_out_total: '2400',
            fee_total: '100',
            last_event_ledger: 200,
            updated_at: new Date().toISOString(),
          },
        ]),
      ],
    );

    const missing = res.rows[0]?.reconcile_group_states ?? [];
    assertEquals(missing, ['C_MISSING_1']);

    const updated = await pg.query<{ contract_id: string; status: string; member_count: number }>(
      `select contract_id, status, member_count from public.groups where contract_id = 'C_EXISTS_1';`,
    );
    assertEquals(updated.rows[0]?.status, 'active');
    assertEquals(updated.rows[0]?.member_count, 4);
  } finally {
    await pg.close();
  }
});

Deno.test('PGlite: bulk reconciliation is not executable by an unprivileged role', async () => {
  const pg = await freshPglite();
  try {
    await pg.exec('create role browser nologin;');
    const result = await pg.query<{ allowed: boolean }>(
      "select has_function_privilege('browser', 'public.reconcile_group_states(jsonb)', 'execute') as allowed",
    );
    assertEquals(result.rows[0]?.allowed, false);
  } finally {
    await pg.close();
  }
});
