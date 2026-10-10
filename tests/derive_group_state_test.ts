/**
 * `derive_group_state`: the bounded-cost replacement for re-reading every fact row.
 *
 * These tests run the actual migration SQL against a real Postgres (PGlite),
 * not a stub: the point is to prove the SQL aggregates match `deriveGroupState`
 * field for field, because a wrong aggregate here would silently mis-derive
 * every group's state on every run.
 *
 * What is covered:
 * - equivalence: the same seeded facts run through the old path
 *   (`readGroupFacts` shape -> `deriveGroupState`) and the new path
 *   (`derive_group_state` RPC -> `readDerivedGroupState`) produce identical
 *   `GroupState`, amounts compared character for character (including a
 *   39-digit amount, past 2^53, where a JSON-number round-trip would corrupt);
 * - boundaries: a group with no facts at all, members but no events, and an
 *   active (started, not completed) group;
 * - performance: 100k contributions reconcile within a documented budget,
 *   versus the old full-row reads.
 */

import { assert, assertEquals } from '@std/assert';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PGlite } from 'npm:@electric-sql/pglite@0.5.8';
import { IndexerDb } from '../supabase/functions/_shared/db.ts';
import {
  deriveGroupState,
  type GroupFacts,
  type GroupState,
  NO_FACTS,
} from '../supabase/functions/_shared/state.ts';

const MIGRATION_URL = new URL(
  '../supabase/migrations/20261009000000_derive_group_state.sql',
  import.meta.url,
);

/** Minimal DDL for the tables the function reads, with the real column types. */
const SCHEMA = `
create table public.group_members (
  contract_id text not null,
  member text not null,
  position integer not null,
  joined_ledger bigint not null,
  event_identity text not null,
  primary key (contract_id, member)
);
create table public.contributions (
  event_identity text primary key,
  contract_id text not null,
  member text not null,
  round integer not null,
  amount numeric(39,0) not null,
  ledger bigint not null,
  tx_hash text not null
);
create table public.payouts (
  event_identity text primary key,
  contract_id text not null,
  recipient text not null,
  round integer not null,
  recipient_amount numeric(39,0) not null,
  ledger bigint not null,
  tx_hash text not null
);
create table public.protocol_fees (
  event_identity text primary key,
  contract_id text not null,
  treasury text not null,
  round integer not null,
  fee numeric(39,0) not null,
  ledger bigint not null,
  tx_hash text not null
);
create table public.decoded_events (
  event_identity text primary key,
  name text not null,
  contract_id text not null,
  ledger bigint not null,
  tx_hash text not null,
  tx_index integer not null,
  event_index integer not null,
  event_id text not null,
  payload jsonb not null
);
`;

type SeedFacts = {
  members: { position: number }[];
  contributions: { round: number; amount: string }[];
  payouts: { round: number; recipient_amount: string }[];
  fees: { round: number; fee: string }[];
  events: { name: string; ledger: number }[];
};

/** A 39-digit amount: past 2^53, where a JSON-number round-trip would corrupt it. */
const HUGE = '999999999999999999999999999999999999999';

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  // The migration grants EXECUTE to service_role, which does not exist in a
  // bare Postgres; create it so the file under test runs unmodified.
  await db.exec('create role service_role nologin;');
  await db.exec(await Deno.readTextFile(MIGRATION_URL));
  return db;
}

async function seedGroup(db: PGlite, contractId: string, facts: SeedFacts): Promise<void> {
  let n = 0;
  const id = () => `${contractId}-evt-${n++}`;
  for (const [i, m] of facts.members.entries()) {
    await db.query(
      `insert into public.group_members (contract_id, member, position, joined_ledger, event_identity)
       values ($1, $2, $3, $4, $5)`,
      [contractId, `member-${i}`, m.position, 100, id()],
    );
  }
  for (const c of facts.contributions) {
    await db.query(
      `insert into public.contributions (event_identity, contract_id, member, round, amount, ledger, tx_hash)
       values ($1, $2, 'member-0', $3, $4, $5, 'tx')`,
      [id(), contractId, c.round, c.amount, 200],
    );
  }
  for (const p of facts.payouts) {
    await db.query(
      `insert into public.payouts (event_identity, contract_id, recipient, round, recipient_amount, ledger, tx_hash)
       values ($1, $2, 'recipient', $3, $4, $5, 'tx')`,
      [id(), contractId, p.round, p.recipient_amount, 300],
    );
  }
  for (const f of facts.fees) {
    await db.query(
      `insert into public.protocol_fees (event_identity, contract_id, treasury, round, fee, ledger, tx_hash)
       values ($1, $2, 'treasury', $3, $4, $5, 'tx')`,
      [id(), contractId, f.round, f.fee, 400],
    );
  }
  for (const e of facts.events) {
    await db.query(
      `insert into public.decoded_events
         (event_identity, name, contract_id, ledger, tx_hash, tx_index, event_index, event_id, payload)
       values ($1, $2, $3, $4, 'tx', 0, 0, 'evt', '{}')`,
      [id(), e.name, contractId, e.ledger],
    );
  }
}

/** An `IndexerDb` whose only transport is the real SQL function via PGlite. */
function dbOverRpc(pglite: PGlite): IndexerDb {
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    assert(fn === 'derive_group_state', `unexpected rpc ${fn}`);
    const result = await pglite.query('select * from public.derive_group_state($1)', [
      args['p_contract_ids'],
    ]);
    return { data: result.rows, error: null };
  };
  return new IndexerDb('http://localhost', 'test-key', { rpc } as unknown as SupabaseClient);
}

function toGroupFacts(seed: SeedFacts): GroupFacts {
  return {
    members: seed.members.map((m) => ({ position: m.position })),
    contributions: seed.contributions.map((c) => ({ round: c.round, amount: c.amount })),
    payouts: seed.payouts.map((p) => ({ round: p.round, recipient_amount: p.recipient_amount })),
    fees: seed.fees.map((f) => ({ round: f.round, fee: f.fee })),
    started: seed.events.some((e) => e.name === 'start'),
    completed: seed.events.some((e) => e.name === 'completed'),
    lastEventLedger: seed.events.reduce((m, e) => Math.max(m, e.ledger), 0),
  };
}

const RICH: SeedFacts = {
  members: [{ position: 1 }, { position: 2 }, { position: 3 }],
  contributions: [
    { round: 1, amount: '1000000' },
    { round: 1, amount: '2000000' },
    { round: 2, amount: '3000000' },
    { round: 2, amount: HUGE },
  ],
  payouts: [{ round: 1, recipient_amount: '5900000' }],
  fees: [{ round: 1, fee: '100000' }],
  events: [
    { name: 'group_created', ledger: 100 },
    { name: 'join', ledger: 101 },
    { name: 'join', ledger: 102 },
    { name: 'join', ledger: 103 },
    { name: 'start', ledger: 104 },
    { name: 'contribution', ledger: 105 },
    { name: 'contribution', ledger: 106 },
    { name: 'contribution', ledger: 107 },
    { name: 'contribution', ledger: 108 },
    { name: 'payout', ledger: 109 },
    { name: 'fee', ledger: 110 },
    { name: 'completed', ledger: 111 },
  ],
};

Deno.test('derive_group_state matches deriveGroupState on the same facts', async () => {
  const db = await freshDb();
  try {
    await seedGroup(db, 'G1', RICH);
    const indexerDb = dbOverRpc(db);

    const actual = await indexerDb.readDerivedGroupState(['G1']);
    assertEquals(actual.length, 1);
    const expected: GroupState = deriveGroupState('G1', toGroupFacts(RICH));

    // Amounts compared character for character: the 39-digit contribution
    // would not survive a JSON-number round-trip, so this pins exactness.
    assertEquals(actual[0], expected);
    assertEquals(actual[0]?.contributed_total, expected.contributed_total);
    const exactTotal = (1000000n + 2000000n + 3000000n + BigInt(HUGE)).toString();
    assertEquals(actual[0]?.contributed_total, exactTotal);
  } finally {
    await db.close();
  }
});

Deno.test('derive_group_state boundaries: empty, members-only, active groups', async () => {
  const db = await freshDb();
  try {
    await seedGroup(db, 'G_MEMBERS', {
      members: [{ position: 1 }, { position: 2 }],
      contributions: [],
      payouts: [],
      fees: [],
      events: [],
    });
    await seedGroup(db, 'G_ACTIVE', {
      members: [{ position: 1 }],
      contributions: [{ round: 1, amount: '500' }],
      payouts: [],
      fees: [],
      events: [{ name: 'start', ledger: 50 }],
    });
    // G_EMPTY is never seeded: the function must still return its zero row,
    // the way the old path defaulted to NO_FACTS.
    const indexerDb = dbOverRpc(db);

    const states = await indexerDb.readDerivedGroupState(['G_EMPTY', 'G_MEMBERS', 'G_ACTIVE']);
    const byId = new Map(states.map((s) => [s.contract_id, s]));

    assertEquals(byId.get('G_EMPTY'), deriveGroupState('G_EMPTY', NO_FACTS));

    const membersOnly = byId.get('G_MEMBERS');
    assertEquals(membersOnly?.member_count, 2);
    assertEquals(membersOnly?.status, 'open');
    assertEquals(membersOnly?.contributed_total, '0');
    assertEquals(membersOnly?.last_event_ledger, 0);

    const active = byId.get('G_ACTIVE');
    assertEquals(active?.status, 'active');
    assertEquals(active?.current_round, 1);
    assertEquals(active?.completed_rounds, 0);
    assertEquals(active?.last_event_ledger, 50);
  } finally {
    await db.close();
  }
});

Deno.test('derive_group_state reconciles 100k contributions within budget', async () => {
  const db = await freshDb();
  try {
    const indexerDb = dbOverRpc(db);

    // 100k contributions across 100 rounds, one member per row batch.
    await db.exec(`
      insert into public.group_members (contract_id, member, position, joined_ledger, event_identity)
      select 'G_BIG', 'member-' || g, g, 1, 'm-' || g from generate_series(1, 50) g;
      insert into public.contributions (event_identity, contract_id, member, round, amount, ledger, tx_hash)
      select 'c-' || g, 'G_BIG', 'member-' || ((g % 50) + 1), 1 + (g % 100), 1000000, g, 'tx'
      from generate_series(1, 100000) g;
      insert into public.payouts (event_identity, contract_id, recipient, round, recipient_amount, ledger, tx_hash)
      select 'p-' || g, 'G_BIG', 'r', g, 49000000, 100000 + g, 'tx' from generate_series(1, 100) g;
      insert into public.protocol_fees (event_identity, contract_id, treasury, round, fee, ledger, tx_hash)
      select 'f-' || g, 'G_BIG', 't', g, 1000000, 100000 + g, 'tx' from generate_series(1, 100) g;
      insert into public.decoded_events
        (event_identity, name, contract_id, ledger, tx_hash, tx_index, event_index, event_id, payload)
      values ('e-start', 'start', 'G_BIG', 1, 'tx', 0, 0, 'evt', '{}');
    `);

    // The old cost model, for the record: five full-row reads, one per fact
    // table, whose output grows with lifetime history.
    const oldStart = performance.now();
    await db.query(
      `select contract_id, position from public.group_members where contract_id = 'G_BIG'`,
    );
    await db.query(
      `select contract_id, round, amount::text from public.contributions where contract_id = 'G_BIG'`,
    );
    await db.query(
      `select contract_id, round, recipient_amount::text from public.payouts where contract_id = 'G_BIG'`,
    );
    await db.query(
      `select contract_id, round, fee::text from public.protocol_fees where contract_id = 'G_BIG'`,
    );
    await db.query(
      `select contract_id, name, ledger from public.decoded_events where contract_id = 'G_BIG'`,
    );
    const oldMs = performance.now() - oldStart;

    const newStart = performance.now();
    const states = await indexerDb.readDerivedGroupState(['G_BIG']);
    const newMs = performance.now() - newStart;

    const state = states[0];
    assert(state !== undefined);
    assertEquals(state.member_count, 50);
    assertEquals(state.current_round, 100);
    assertEquals(state.completed_rounds, 100);
    // 100k x 1000000, exact: no float anywhere near this path.
    assertEquals(state.contributed_total, '100000000000');
    assertEquals(state.paid_out_total, '4900000000');
    assertEquals(state.fee_total, '100000000');
    assertEquals(state.status, 'active');

    console.log(
      `100k contributions: old full-row reads ${oldMs.toFixed(0)}ms, aggregated ${
        newMs.toFixed(0)
      }ms`,
    );

    // Documented budget: the aggregated reconcile must stay comfortably inside
    // the 5-minute function budget even on wasm Postgres; production Postgres
    // is an order of magnitude faster than PGlite. 30s is generous on purpose:
    // this guards against regressions to full-history reads, not against
    // millisecond noise.
    assert(newMs < 30_000, `aggregated reconcile took ${newMs.toFixed(0)}ms, over budget`);
  } finally {
    await db.close();
  }
});
