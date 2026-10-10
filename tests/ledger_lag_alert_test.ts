/**
 * Ledger lag alert, against a real PostgreSQL (PGlite).
 *
 * The condition lives entirely in the `check_indexer_health` plpgsql function —
 * the threshold comparison, the one-open-per-(kind,subject) behavior, and the
 * resolve-on-recovery. A mock would assert nothing about the SQL, so this test
 * applies the real migrations and calls the real function.
 */
import { PGlite } from 'npm:@electric-sql/pglite@0.3.4';
import { assertEquals } from '@std/assert';

const MIGRATIONS = [
  'supabase/migrations/20260808000000_indexer_core.sql',
  'supabase/migrations/20260816000000_chain_derived.sql',
  'supabase/migrations/20260914000000_indexer_alerts.sql',
  'supabase/migrations/20261009000001_ledger_lag_alert.sql',
  'supabase/migrations/20261011000002_inflight_cron_runs_not_failed.sql',
];

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  for (const m of MIGRATIONS) {
    const sql = await Deno.readTextFile(m);
    await db.exec(sql);
  }
  return db;
}

async function openAlerts(db: PGlite) {
  const r = await db.query(
    'select kind, subject, detail from public.indexer_alerts where resolved_at is null order by kind',
  );
  return r.rows as { kind: string; subject: string; detail: Record<string, number> }[];
}

Deno.test('lag above the threshold opens a ledger_lag alert', async () => {
  const db = new PGlite();
  try {
    for (const m of MIGRATIONS) {
      await db.exec(await Deno.readTextFile(m));
    }
    // Checkpoint at 1,000,000, tip observed at 1,100,000 → lag 100,000 > 60,000.
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, last_seen_latest_ledger)
       values ('default', 1000000, 1, 1100000)`,
    );
    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    const open = await openAlerts(db);
    const lag = open.filter((a) => a.kind === 'ledger_lag');
    assertEquals(lag.length, 1);
    const row = lag[0]!;
    assertEquals(row.subject, 'default');
    assertEquals(row.detail.lagLedgers, 100000);
    assertEquals(row.detail.thresholdLedgers, 60000);
  } finally {
    await db.close();
  }
});

Deno.test('lag below the threshold opens nothing', async () => {
  const db = await freshDb();
  try {
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, last_seen_latest_ledger)
       values ('default', 1000000, 1, 1050000)`,
    );
    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    const open = (await openAlerts(db)).filter((a) => a.kind === 'ledger_lag');
    assertEquals(open.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test('a persisting lag refreshes the same row instead of opening another', async () => {
  const db = await freshDb();
  try {
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, last_seen_latest_ledger)
       values ('default', 1000000, 1, 1100000)`,
    );
    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    await db.exec(
      "update public.indexer_checkpoints set last_seen_latest_ledger = 1200000 where id = 'default'",
    );
    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    const open = (await openAlerts(db)).filter((a) => a.kind === 'ledger_lag');
    assertEquals(open.length, 1);
    assertEquals(open[0]!.detail.lagLedgers, 200000);
  } finally {
    await db.close();
  }
});

Deno.test('a recovered lag resolves the open alert', async () => {
  const db = await freshDb();
  try {
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, last_seen_latest_ledger)
       values ('default', 1000000, 1, 1100000)`,
    );
    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    assertEquals((await openAlerts(db)).filter((a) => a.kind === 'ledger_lag').length, 1);
    // Checkpoint catches up: lag drops to 10,000.
    await db.exec(
      "update public.indexer_checkpoints set last_processed_ledger = 1090000, last_seen_latest_ledger = 1100000 where id = 'default'",
    );
    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    assertEquals((await openAlerts(db)).filter((a) => a.kind === 'ledger_lag').length, 0);
    // The row is resolved, not deleted — history stays readable.
    const r = await db.query(
      "select count(*)::int as n from public.indexer_alerts where kind = 'ledger_lag' and resolved_at is not null",
    );
    assertEquals((r.rows[0] as { n: number }).n, 1);
  } finally {
    await db.close();
  }
});

Deno.test('a custom threshold is honored', async () => {
  const db = await freshDb();
  try {
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, last_seen_latest_ledger)
       values ('default', 1000000, 1, 1100000)`,
    );
    // Lag 100,000 with a 150,000 threshold → no alert.
    await db.exec(
      "select public.check_indexer_health('30 minutes', '1 hour', false, 150000);",
    );
    assertEquals((await openAlerts(db)).filter((a) => a.kind === 'ledger_lag').length, 0);
  } finally {
    await db.close();
  }
});

Deno.test('a null last_seen_latest_ledger (pre-upgrade row) opens nothing', async () => {
  const db = await freshDb();
  try {
    await db.exec(
      `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger)
       values ('default', 1000000, 1)`,
    );
    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    assertEquals((await openAlerts(db)).filter((a) => a.kind === 'ledger_lag').length, 0);
  } finally {
    await db.close();
  }
});
