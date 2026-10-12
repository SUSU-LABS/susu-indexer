/**
 * Webhook delivery confirmation and retry tests against real PostgreSQL (PGlite).
 */
import { PGlite } from 'npm:@electric-sql/pglite@0.3.4';
import { assertEquals } from '@std/assert';

const CORE_MIGRATIONS = [
  'supabase/migrations/20260808000000_indexer_core.sql',
  'supabase/migrations/20260816000000_chain_derived.sql',
  'supabase/migrations/20260914000000_indexer_alerts.sql',
  'supabase/migrations/20261009000001_ledger_lag_alert.sql',
];

const NEW_MIGRATION = 'supabase/migrations/20261012000000_confirm_webhook_delivery.sql';

async function setupDb(): Promise<PGlite> {
  const db = new PGlite();

  // 1. Core schema
  for (const m of CORE_MIGRATIONS) {
    const sql = await Deno.readTextFile(m);
    await db.exec(sql);
  }

  // 2. Setup mock extensions (vault and net) as present in Supabase
  await db.exec(`
    create schema if not exists vault;
    create table if not exists vault.decrypted_secrets (
      name text primary key,
      decrypted_secret text not null
    );
    insert into vault.decrypted_secrets (name, decrypted_secret)
    values ('indexer_alert_webhook', 'https://webhook.example.test/alerts');

    create schema if not exists net;
    create sequence if not exists net.request_id_seq start 1;

    create table if not exists net._http_response (
      id bigint primary key,
      status_code integer,
      content text,
      error_msg text,
      timed_out boolean default false
    );

    create or replace function net.http_post(
      url text,
      headers jsonb default '{}'::jsonb,
      body jsonb default '{}'::jsonb,
      params jsonb default '{}'::jsonb,
      timeout_milliseconds integer default 1000
    )
    returns integer
    language sql
    as $$
      select nextval('net.request_id_seq')::integer;
    $$;
  `);

  // 3. Apply delivery confirmation migration
  const newSql = await Deno.readTextFile(NEW_MIGRATION);
  await db.exec(newSql);

  return db;
}

Deno.test('webhook delivery: failed webhook leaves notified_at null and retries; 2xx marks notified_at once', async () => {
  const db = await setupDb();
  try {
    // 1. Initial stale checkpoint opens alert and enqueues pg_net webhook
    await db.exec(`
      insert into public.indexer_checkpoints (id, last_processed_ledger, start_ledger, updated_at)
      values ('default', 1000, 1, now() - interval '2 hours');
    `);

    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', true);");

    const alertsAfterFirstRun = await db.query(
      'select id, kind, notified_at, notify_request_id from public.indexer_alerts;',
    );
    assertEquals(alertsAfterFirstRun.rows.length, 1);
    const alert = alertsAfterFirstRun.rows[0] as {
      id: string;
      kind: string;
      notified_at: string | null;
      notify_request_id: number;
    };
    assertEquals(alert.notified_at, null, 'notified_at must remain null while in-flight');
    assertEquals(alert.notify_request_id, 1, 'notify_request_id must be recorded');

    // 2. Simulate failed delivery (HTTP 500)
    await db.exec(`
      insert into net._http_response (id, status_code, error_msg)
      values (1, 500, 'Internal Server Error');
    `);

    // Next health check run reconciles response: clears notify_request_id and re-queues
    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', true);");

    const alertsAfterFailedWebhook = await db.query(
      'select id, notified_at, notify_request_id from public.indexer_alerts;',
    );
    const retriedAlert = alertsAfterFailedWebhook.rows[0] as {
      id: string;
      notified_at: string | null;
      notify_request_id: number;
    };
    assertEquals(
      retriedAlert.notified_at,
      null,
      'failed webhook must leave notified_at null for retry',
    );
    assertEquals(retriedAlert.notify_request_id, 2, 'retry generates new request id');

    // 3. Simulate successful delivery (HTTP 200)
    await db.exec(`
      insert into net._http_response (id, status_code, content)
      values (2, 200, '{"ok":true}');
    `);

    // Next health check run reconciles 200: marks notified_at and clears in-flight id
    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', true);");

    const alertsAfterSuccess = await db.query(
      'select id, notified_at, notify_request_id from public.indexer_alerts;',
    );
    const succeededAlert = alertsAfterSuccess.rows[0] as {
      id: string;
      notified_at: string | null;
      notify_request_id: number | null;
    };
    assertEquals(
      succeededAlert.notified_at !== null,
      true,
      'notified_at must be populated after 200',
    );
    assertEquals(
      succeededAlert.notify_request_id,
      null,
      'notify_request_id is cleared after success',
    );

    // 4. Subsequent run does not re-notify already notified alert
    const prevNotifiedAt = succeededAlert.notified_at;
    await db.exec("select public.check_indexer_health('30 minutes', '1 hour', true);");

    const alertsAfterSubsequent = await db.query(
      'select id, notified_at, notify_request_id from public.indexer_alerts;',
    );
    const stableAlert = alertsAfterSubsequent.rows[0] as {
      id: string;
      notified_at: string;
      notify_request_id: number | null;
    };
    assertEquals(stableAlert.notified_at, prevNotifiedAt, 'notified_at remains unchanged');
    assertEquals(stableAlert.notify_request_id, null);
  } finally {
    await db.close();
  }
});
