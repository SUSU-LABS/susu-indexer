/**
 * Webhook delivery at-least-once reconciliation tests (PGlite).
 */
import { PGlite } from 'npm:@electric-sql/pglite@0.3.4';
import { assertEquals, assertNotEquals } from '@std/assert';

const MIGRATIONS = [
  'supabase/migrations/20260808000000_indexer_core.sql',
  'supabase/migrations/20260816000000_chain_derived.sql',
  'supabase/migrations/20260914000000_indexer_alerts.sql',
  'supabase/migrations/20261009000001_ledger_lag_alert.sql',
  'supabase/migrations/20261010000000_confirm_webhook_delivery.sql',
];

async function setupDbWithMockNet(
  mockStatusCode: number,
  mockError: string | null = null,
): Promise<PGlite> {
  const db = new PGlite();

  // Create mock vault and net schemas
  await db.exec(`
    create schema if not exists vault;
    create table if not exists vault.decrypted_secrets (
      name text primary key,
      decrypted_secret text not null
    );
    insert into vault.decrypted_secrets (name, decrypted_secret)
    values ('indexer_alert_webhook', 'https://webhook.example.com/alerts');

    create schema if not exists net;
    create sequence if not exists net.request_id_seq;
    create table if not exists net._http_response (
      id bigint primary key,
      status_code integer,
      content text,
      error_msg text
    );
  `);

  // Define mock net.http_post
  const errorLiteral = mockError ? `'${mockError}'` : 'null';
  await db.exec(`
    create or replace function net.http_post(
      url text,
      headers jsonb,
      body jsonb,
      timeout_milliseconds integer
    )
    returns bigint as $$
    declare
      v_id bigint := nextval('net.request_id_seq');
    begin
      insert into net._http_response (id, status_code, content, error_msg)
      values (v_id, ${mockStatusCode}, '{"ok": true}', ${errorLiteral});
      return v_id;
    end;
    $$ language plpgsql;
  `);

  // Apply migrations
  for (const m of MIGRATIONS) {
    const sql = await Deno.readTextFile(m);
    await db.exec(sql);
  }

  return db;
}

Deno.test('successful delivery (2xx) sets notified_at once', async () => {
  const db = await setupDbWithMockNet(200);

  // Run check with 0s threshold to trigger stale_checkpoint alert
  const res1 = await db.query<{ notified: number }>(
    "select notified from public.check_indexer_health('0 seconds', '1 hour', true);",
  );
  assertEquals(res1.rows[0]?.notified, 1);

  const alertRow = await db.query<{ notified_at: string | null }>(
    "select notified_at from public.indexer_alerts where kind = 'stale_checkpoint';",
  );
  assertNotEquals(alertRow.rows[0]?.notified_at, null);

  // Subsequent check does not notify again
  const res2 = await db.query<{ notified: number }>(
    "select notified from public.check_indexer_health('0 seconds', '1 hour', true);",
  );
  assertEquals(res2.rows[0]?.notified, 0);
});

Deno.test('failed delivery (500) leaves notified_at null and is retried on subsequent pass', async () => {
  const db = await setupDbWithMockNet(500);

  // Run check with 500 error response
  const res1 = await db.query<{ notified: number }>(
    "select notified from public.check_indexer_health('0 seconds', '1 hour', true);",
  );
  assertEquals(res1.rows[0]?.notified, 0);

  const alertRow1 = await db.query<{ notified_at: string | null }>(
    "select notified_at from public.indexer_alerts where kind = 'stale_checkpoint';",
  );
  assertEquals(alertRow1.rows[0]?.notified_at, null);

  // Now simulate webhook recovery (200 OK)
  await db.exec(`
    create or replace function net.http_post(
      url text,
      headers jsonb,
      body jsonb,
      timeout_milliseconds integer
    )
    returns bigint as $$
    declare
      v_id bigint := nextval('net.request_id_seq');
    begin
      insert into net._http_response (id, status_code, content, error_msg)
      values (v_id, 200, '{"ok": true}', null);
      return v_id;
    end;
    $$ language plpgsql;
  `);

  // Next run retries and succeeds
  const res2 = await db.query<{ notified: number }>(
    "select notified from public.check_indexer_health('0 seconds', '1 hour', true);",
  );
  assertEquals(res2.rows[0]?.notified, 1);

  const alertRow2 = await db.query<{ notified_at: string | null }>(
    "select notified_at from public.indexer_alerts where kind = 'stale_checkpoint';",
  );
  assertNotEquals(alertRow2.rows[0]?.notified_at, null);
});

Deno.test('transport error leaves notified_at null and is retried on recovery', async () => {
  const db = await setupDbWithMockNet(0, 'connection refused');

  const res1 = await db.query<{ notified: number }>(
    "select notified from public.check_indexer_health('0 seconds', '1 hour', true);",
  );
  assertEquals(res1.rows[0]?.notified, 0);

  const alertRow1 = await db.query<{ notified_at: string | null }>(
    "select notified_at from public.indexer_alerts where kind = 'stale_checkpoint';",
  );
  assertEquals(alertRow1.rows[0]?.notified_at, null);

  // Recovery
  await db.exec(`
    create or replace function net.http_post(
      url text,
      headers jsonb,
      body jsonb,
      timeout_milliseconds integer
    )
    returns bigint as $$
    declare
      v_id bigint := nextval('net.request_id_seq');
    begin
      insert into net._http_response (id, status_code, content, error_msg)
      values (v_id, 200, '{"ok": true}', null);
      return v_id;
    end;
    $$ language plpgsql;
  `);

  const res2 = await db.query<{ notified: number }>(
    "select notified from public.check_indexer_health('0 seconds', '1 hour', true);",
  );
  assertEquals(res2.rows[0]?.notified, 1);

  const alertRow2 = await db.query<{ notified_at: string | null }>(
    "select notified_at from public.indexer_alerts where kind = 'stale_checkpoint';",
  );
  assertNotEquals(alertRow2.rows[0]?.notified_at, null);
});
