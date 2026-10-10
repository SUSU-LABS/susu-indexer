/**
 * In-flight pg_cron runs must not open `failed_schedule` alerts.
 *
 * `check_indexer_health` used to flag `cron.job_run_details` rows with
 * `status <> 'succeeded'`. pg_cron writes `status = 'running'` while a job
 * executes, so the health check itself was misreported as failed every time
 * it ran inside its own execution window. The fix matches only terminal
 * failures (`status = 'failed'`).
 *
 * A stub `cron` schema stands in for pg_cron (PGlite has no background
 * worker): the shape matches `cron.job` / `cron.job_run_details`.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.0';
import { PGlite } from 'npm:@electric-sql/pglite@0.3.10';
import { readFile } from 'node:fs/promises';

const BASE_MIGRATION = new URL(
  '../supabase/migrations/20260914000000_indexer_alerts.sql',
  import.meta.url,
);
const FIX_MIGRATION = new URL(
  '../supabase/migrations/20261011000000_inflight_runs_not_failed.sql',
  import.meta.url,
);

const BASE_SCHEMA = `
-- Supabase roles referenced by grant/revoke statements.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

create schema if not exists vault;
create table if not exists vault.decrypted_secrets (
  name text primary key,
  decrypted_secret text not null
);

create table if not exists public.indexer_checkpoints (
  id text primary key,
  last_processed_ledger bigint not null check (last_processed_ledger >= 0),
  start_ledger bigint not null check (start_ledger >= 0),
  updated_at timestamptz not null default now(),
  -- Added by 20261009000001_ledger_lag_alert.sql (#44); the fixed function
  -- references it.
  last_seen_latest_ledger bigint check (last_seen_latest_ledger >= 0)
);

create table if not exists public.indexer_runs (
  id uuid primary key default gen_random_uuid(),
  correlation_id text not null,
  ledger_from bigint not null check (ledger_from >= 0),
  ledger_to bigint not null check (ledger_to >= 0),
  status text not null check (status in ('ok', 'failed', 'skipped')),
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.indexer_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('stale_checkpoint', 'failed_run', 'failed_schedule')),
  subject text not null,
  detail jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz,
  notified_at timestamptz,
  constraint indexer_alerts_resolved_after_opened
    check (resolved_at is null or resolved_at >= opened_at)
);
create unique index if not exists indexer_alerts_open_idx
  on public.indexer_alerts (kind, subject) where resolved_at is null;

-- Stub pg_cron: PGlite has no background worker, so we create the schema
-- and tables with the real column shapes.
create schema if not exists cron;
create table if not exists cron.job (
  jobid bigint primary key,
  jobname text not null
);
create table if not exists cron.job_run_details (
  jobid bigint not null,
  runid bigint not null,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz,
  primary key (jobid, runid)
);
-- Stub cron.schedule/unschedule: the base migration's scheduling DO block
-- calls them when the cron schema exists. No-op stubs keep the migration
-- applying cleanly in PGlite.
create or replace function cron.schedule(jobname text, schedule text, command text)
returns bigint language plpgsql as $$ begin return 1; end; $$;
create or replace function cron.unschedule(jobname text)
returns boolean language plpgsql as $$ begin return true; end; $$;
`;

async function freshDb(withFix: boolean) {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  const base = await readFile(BASE_MIGRATION, 'utf8');
  await db.exec(base);
  if (withFix) {
    // The fix migration defines the 4-param signature (with lag_threshold_ledgers
    // from #44). Drop the 3-param version first to avoid overload ambiguity.
    await db.exec(
      `drop function if exists public.check_indexer_health(interval, interval, boolean)`,
    );
    const fix = await readFile(FIX_MIGRATION, 'utf8');
    await db.exec(fix);
  }
  // Fresh checkpoint so stale_checkpoint does not fire and mask the
  // failed_schedule signal under test.
  await db.exec(
    `insert into public.indexer_checkpoints(id, last_processed_ledger, start_ledger, updated_at)
     values ('default', 1000, 1, now())`,
  );
  // One cron job to hang run details off.
  await db.exec(
    `insert into cron.job(jobid, jobname) values (1, 'susu-indexer-health')`,
  );
  return db;
}

async function openFailedScheduleCount(db: PGlite): Promise<number> {
  const rows = await db.query(
    `select count(*)::int as n from public.indexer_alerts
     where kind = 'failed_schedule' and resolved_at is null`,
  );
  return (rows.rows[0] as { n: number }).n;
}

Deno.test('running pg_cron rows do not open failed_schedule (fix)', async () => {
  const db = await freshDb(true);
  try {
    // A run that is still in flight: status 'running', no end_time.
    await db.exec(
      `insert into cron.job_run_details(jobid, runid, status, return_message, start_time, end_time)
       values (1, 101, 'running', null, now() - interval '1 minute', null)`,
    );
    await db.exec(`select public.check_indexer_health(send_notifications := false)`);
    assertEquals(await openFailedScheduleCount(db), 0);
  } finally {
    await db.close();
  }
});

Deno.test('running rows are misreported without the fix (regression)', async () => {
  const db = await freshDb(false);
  try {
    await db.exec(
      `insert into cron.job_run_details(jobid, runid, status, return_message, start_time, end_time)
       values (1, 101, 'running', null, now() - interval '1 minute', null)`,
    );
    await db.exec(`select public.check_indexer_health(send_notifications := false)`);
    // Old behavior: the in-flight run opens a spurious alert.
    assertEquals(await openFailedScheduleCount(db), 1);
  } finally {
    await db.close();
  }
});

Deno.test('failed pg_cron rows still open failed_schedule with message (fix)', async () => {
  const db = await freshDb(true);
  try {
    await db.exec(
      `insert into cron.job_run_details(jobid, runid, status, return_message, start_time, end_time)
       values (1, 102, 'failed', 'connection refused', now() - interval '5 minutes', now() - interval '4 minutes')`,
    );
    await db.exec(`select public.check_indexer_health(send_notifications := false)`);
    assertEquals(await openFailedScheduleCount(db), 1);
    const rows = await db.query(
      `select detail from public.indexer_alerts
       where kind = 'failed_schedule' and resolved_at is null`,
    );
    const detail = (rows.rows[0] as { detail: { newestMessage: string } }).detail;
    assert(detail.newestMessage.includes('connection refused'));
  } finally {
    await db.close();
  }
});

Deno.test('succeeded rows never open failed_schedule (fix)', async () => {
  const db = await freshDb(true);
  try {
    await db.exec(
      `insert into cron.job_run_details(jobid, runid, status, return_message, start_time, end_time)
       values (1, 103, 'succeeded', 'ok', now() - interval '5 minutes', now() - interval '4 minutes')`,
    );
    await db.exec(`select public.check_indexer_health(send_notifications := false)`);
    assertEquals(await openFailedScheduleCount(db), 0);
  } finally {
    await db.close();
  }
});
