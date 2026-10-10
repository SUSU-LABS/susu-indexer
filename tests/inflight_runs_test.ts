/**
 * pg_cron in-flight runs test, against a real PostgreSQL (PGlite).
 *
 * `check_indexer_health` should only match terminal failures (`status = 'failed'`).
 * In-flight executions (`status = 'running'`) must not open spurious `failed_schedule` alerts.
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

  // Create cron schema & tables mock to simulate pg_cron extension after migrations
  await db.exec(`
    create schema if not exists cron;
    create table if not exists cron.job (
      jobid bigint primary key,
      jobname text not null
    );
    create table if not exists cron.job_run_details (
      runid bigserial primary key,
      jobid bigint references cron.job(jobid),
      status text not null,
      return_message text,
      start_time timestamptz not null default now(),
      end_time timestamptz
    );
  `);

  // Active fresh checkpoint so stale_checkpoint is not open
  await db.exec(`
    insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, updated_at)
    values ('default', 1000, 1, now());
  `);

  return db;
}

async function openAlerts(db: PGlite) {
  const r = await db.query(
    'select kind, subject, detail from public.indexer_alerts where resolved_at is null order by kind',
  );
  return r.rows as { kind: string; subject: string; detail: Record<string, unknown> }[];
}

Deno.test("in-flight ('running') job does not open a failed_schedule alert", async () => {
  const db = await freshDb();
  try {
    await db.exec(`
      insert into cron.job (jobid, jobname) values (1, 'susu-indexer-health');
      insert into cron.job_run_details (jobid, status, return_message, start_time)
      values (1, 'running', null, now());
    `);

    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    const open = (await openAlerts(db)).filter((a) => a.kind === 'failed_schedule');
    assertEquals(open.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test('failed job opens a failed_schedule alert with message', async () => {
  const db = await freshDb();
  try {
    await db.exec(`
      insert into cron.job (jobid, jobname) values (1, 'susu-indexer-batch');
      insert into cron.job_run_details (jobid, status, return_message, start_time)
      values (1, 'failed', 'RPC endpoint unreachable: connection timeout', now());
    `);

    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    const open = (await openAlerts(db)).filter((a) => a.kind === 'failed_schedule');
    assertEquals(open.length, 1);
    const row = open[0]!;
    assertEquals(row.subject, 'susu-indexer-batch');
    assertEquals(row.detail.failures, 1);
    assertEquals(row.detail.newestMessage, 'RPC endpoint unreachable: connection timeout');
  } finally {
    await db.close();
  }
});

Deno.test('succeeded job does not open a failed_schedule alert', async () => {
  const db = await freshDb();
  try {
    await db.exec(`
      insert into cron.job (jobid, jobname) values (1, 'susu-indexer-batch');
      insert into cron.job_run_details (jobid, status, return_message, start_time, end_time)
      values (1, 'succeeded', 'Job completed successfully', now() - interval '5 minutes', now());
    `);

    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    const open = (await openAlerts(db)).filter((a) => a.kind === 'failed_schedule');
    assertEquals(open.length, 0);
  } finally {
    await db.close();
  }
});

Deno.test('transition from running to failed opens alert on next check', async () => {
  const db = await freshDb();
  try {
    await db.exec(`
      insert into cron.job (jobid, jobname) values (1, 'susu-indexer-batch');
      insert into cron.job_run_details (runid, jobid, status, return_message, start_time)
      values (100, 1, 'running', null, now());
    `);

    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    assertEquals((await openAlerts(db)).filter((a) => a.kind === 'failed_schedule').length, 0);

    // Later job marks as failed
    await db.exec(`
      update cron.job_run_details
      set status = 'failed', return_message = 'Process terminated with code 1'
      where runid = 100;
    `);

    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', false);");
    const open = (await openAlerts(db)).filter((a) => a.kind === 'failed_schedule');
    assertEquals(open.length, 1);
    assertEquals(open[0]!.subject, 'susu-indexer-batch');
    assertEquals(open[0]!.detail.newestMessage, 'Process terminated with code 1');
  } finally {
    await db.close();
  }
});
