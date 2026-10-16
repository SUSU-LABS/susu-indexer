/**
 * Alert notification confirmation, against a real PostgreSQL (PGlite).
 *
 * `net.http_post` only queues a request, so the notify loop has to read the
 * response back from `net._http_response` before it may stamp `notified_at`.
 * Supabase's `net` extension is not available here, so the stub below plays
 * its part: it records a queued request, and the status code it hands back is
 * driven by the test so both the 2xx and the non-2xx branch are real.
 */
import { PGlite } from 'npm:@electric-sql/pglite@0.3.4';
import { assertEquals } from '@std/assert';

const MIGRATIONS = [
  'supabase/migrations/20260808000000_indexer_core.sql',
  'supabase/migrations/20260816000000_chain_derived.sql',
  'supabase/migrations/20260914000000_indexer_alerts.sql',
  'supabase/migrations/20261009000001_ledger_lag_alert.sql',
];

// The stub resolves the queued request synchronously, so the loop's first
// poll already sees it and no retry sleep is ever taken.
const NET_STUB = `
create schema if not exists net;
create table if not exists net.stub_status (status_code integer);
create table if not exists net._http_response (id bigint, status_code integer);
create or replace function net.http_post(
  url text, headers jsonb, body jsonb, timeout_milliseconds integer default 10000
) returns bigint
language plpgsql
as $$
declare
  v_id bigint;
begin
  select coalesce(max(r.id), 0) + 1 into v_id from net._http_response r;
  insert into net._http_response (id, status_code)
  select v_id, s.status_code from net.stub_status s limit 1;
  return v_id;
end;
$$;
create schema if not exists vault;
create table if not exists vault.decrypted_secrets (name text, decrypted_secret text);
insert into vault.decrypted_secrets values ('indexer_alert_webhook', 'https://example.invalid/hook');
`;

async function freshDb(statusCode: number): Promise<PGlite> {
  const db = new PGlite();
  for (const m of MIGRATIONS) {
    await db.exec(await Deno.readTextFile(m));
  }
  await db.exec(NET_STUB);
  await db.exec(`insert into net.stub_status values (${statusCode})`);
  // Lag 100,000 > the 60,000 default threshold, so an alert is open.
  await db.exec(
    `insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, last_seen_latest_ledger)
     values ('default', 1000000, 1, 1100000)`,
  );
  return db;
}

async function runHealthCheck(db: PGlite) {
  const r = await db.query(
    "select * from public.check_indexer_health('30 minutes', '1 hour', true)",
  );
  return r.rows[0] as { opened: number; resolved: number; open_now: number; notified: number };
}

async function notifiedAt(db: PGlite): Promise<(string | null)[]> {
  const r = await db.query(
    'select notified_at from public.indexer_alerts where kind = $1',
    ['ledger_lag'],
  );
  return (r.rows as { notified_at: string | null }[]).map((row) => row.notified_at);
}

Deno.test('a 2xx webhook response marks the alert notified once', async () => {
  const db = await freshDb(200);
  try {
    const first = await runHealthCheck(db);
    assertEquals(first.notified, 1);
    assertEquals((await notifiedAt(db)).filter((v) => v !== null).length, 1);

    // A second pass has nothing left to send: the alert is already notified.
    const again = await runHealthCheck(db);
    assertEquals(again.notified, 0);
    assertEquals((await notifiedAt(db)).filter((v) => v !== null).length, 1);
  } finally {
    await db.close();
  }
});

Deno.test('a non-2xx webhook response leaves notified_at null for the next pass', async () => {
  const db = await freshDb(500);
  try {
    const first = await runHealthCheck(db);
    assertEquals(first.notified, 0);
    // The alert itself is still recorded — silence is not health.
    assertEquals(first.open_now, 1);
    const afterFailure = await notifiedAt(db);
    assertEquals(afterFailure.length, 1);
    assertEquals(afterFailure[0], null);

    // The endpoint recovers; the same open alert is delivered on the next run.
    await db.exec('update net.stub_status set status_code = 200');
    const retried = await runHealthCheck(db);
    assertEquals(retried.notified, 1);
    assertEquals((await notifiedAt(db)).filter((v) => v !== null).length, 1);
  } finally {
    await db.close();
  }
});
