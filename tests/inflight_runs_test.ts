/**
 * Tests verifying that in-flight (status = 'running') pg_cron jobs are not treated
 * as failures, while terminal failures (status = 'failed') correctly open alerts.
 */
import { PGlite } from 'npm:@electric-sql/pglite@0.3.4';
import { assertEquals } from '@std/assert';

const MIGRATIONS = [
  'supabase/migrations/20260808000000_indexer_core.sql',
  'supabase/migrations/20260816000000_chain_derived.sql',
  'supabase/migrations/20260914000000_indexer_alerts.sql',
  'supabase/migrations/20261009000001_ledger_lag_alert.sql',
  'supabase/migrations/20261010000000_inflight_cron_runs_not_failed.sql',
];

async function setupDb(): Promise<PGlite> {
  const db = new PGlite();
  for (const m of MIGRATIONS) {
    const sql = await Deno.readTextFile(m);
    await db.exec(sql);
  }
  // Setup cron schema and mock tables
  await db.exec(`
    create schema if not exists cron;
    create table if not exists cron.job (
      jobid bigint primary key,
      jobname text not null
    );
    create table if not exists cron.job_run_details (
      runid bigserial primary key,
      jobid bigint not null references cron.job(jobid),
      status text not null,
      return_message text,
      start_time timestamptz not null default now(),
      end_time timestamptz
    );
  `);
  // Seed a valid checkpoint so stale_checkpoint doesn't fire
  await db.exec(`
    insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, last_seen_latest_ledger, updated_at)
    values ('default', 1000000, 1, 1000000, now());
  `);
  return db;
}

async function openAlerts(db: PGlite) {
  const r = await db.query(
    'select kind, subject, detail from public.indexer_alerts where resolved_at is null order by kind',
  );
  return r.rows as { kind: string; subject: string; detail: Record<string, unknown> }[];
}

Deno.test('an in-flight (running) job does NOT produce a failed_schedule alert', async () => {
  const db = await setupDb();
  try {
    await db.exec(`
      insert into cron.job (jobid, jobname) values (1, 'indexer-poll');
      insert into cron.job_run_details (jobid, status, return_message, start_time)
      values (1, 'running', null, now());
    `);

    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    const alerts = await openAlerts(db);
    const failedSchedules = alerts.filter((a) => a.kind === 'failed_schedule');
    assertEquals(failedSchedules.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test('a failed job DOES produce a failed_schedule alert with message', async () => {
  const db = await setupDb();
  try {
    await db.exec(`
      insert into cron.job (jobid, jobname) values (1, 'indexer-poll');
      insert into cron.job_run_details (jobid, status, return_message, start_time, end_time)
      values (1, 'failed', 'connection timeout to node', now(), now());
    `);

    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    const alerts = await openAlerts(db);
    const failedSchedules = alerts.filter((a) => a.kind === 'failed_schedule');
    assertEquals(failedSchedules.length, 1);
    assertEquals(failedSchedules[0]!.subject, 'indexer-poll');
    assertEquals(failedSchedules[0]!.detail.failures, 1);
    assertEquals(failedSchedules[0]!.detail.newestMessage, 'connection timeout to node');
  } finally {
    await db.close();
  }
});

Deno.test('a succeeded job does NOT produce a failed_schedule alert', async () => {
  const db = await setupDb();
  try {
    await db.exec(`
      insert into cron.job (jobid, jobname) values (1, 'indexer-poll');
      insert into cron.job_run_details (jobid, status, return_message, start_time, end_time)
      values (1, 'succeeded', 'processed 100 ledgers', now(), now());
    `);

    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    const alerts = await openAlerts(db);
    const failedSchedules = alerts.filter((a) => a.kind === 'failed_schedule');
    assertEquals(failedSchedules.length, 0);
  } finally {
    await db.close();
  }
});
