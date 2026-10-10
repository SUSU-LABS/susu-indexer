import { PGlite } from 'npm:@electric-sql/pglite@0.3.4';
import { assertEquals, assertNotEquals } from '@std/assert';

const migrations = [
  '20260808000000_indexer_core.sql',
  '20260816000000_chain_derived.sql',
  '20260914000000_indexer_alerts.sql',
  '20261009000001_ledger_lag_alert.sql',
  '20261010000000_confirm_webhook_delivery.sql',
];

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema vault;
    create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
    insert into vault.decrypted_secrets values ('indexer_alert_webhook', 'https://example.test/alerts');
    create schema net;
    create table net.requests (id bigserial primary key, body jsonb);
    create table net._http_response (id bigint primary key, status_code integer, error_msg text, timed_out boolean);
    create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds integer)
    returns bigint language sql as $$
      insert into net.requests(body) values ($3) returning id;
    $$;
  `);
  for (const name of migrations) {
    await db.exec(await Deno.readTextFile(`supabase/migrations/${name}`));
  }
  return db;
}

async function check(db: PGlite) {
  const result = await db.query<{ notified: number }>(
    "select notified from public.check_indexer_health('0 seconds', '1 hour', true)",
  );
  return result.rows[0]?.notified;
}
async function alert(db: PGlite) {
  const result = await db.query<{ notified_at: string | null; notification_request_id: number }>(
    "select notified_at, notification_request_id from public.indexer_alerts where kind='stale_checkpoint'",
  );
  return result.rows[0]!;
}
async function respond(
  db: PGlite,
  status: number | null,
  error: string | null = null,
  timeout = false,
) {
  await db.query('insert into net._http_response values ($1, $2, $3, $4)', [
    (await alert(db)).notification_request_id,
    status,
    error,
    timeout,
  ]);
}

Deno.test('queueing is not delivery; a later 2xx confirms exactly once', async () => {
  const db = await freshDb();
  try {
    assertEquals(await check(db), 0);
    const queued = await alert(db);
    assertEquals(queued.notified_at, null);
    assertEquals(await check(db), 0);
    assertEquals((await alert(db)).notification_request_id, queued.notification_request_id);
    await respond(db, 204);
    assertEquals(await check(db), 1);
    const delivered = await alert(db);
    assertNotEquals(delivered.notified_at, null);
    assertEquals(await check(db), 0);
    assertEquals((await alert(db)).notified_at, delivered.notified_at);
  } finally {
    await db.close();
  }
});

for (
  const [label, status, error, timeout] of [
    ['server error', 500, null, false],
    ['transport error', null, 'connection refused', false],
    ['timeout without status', null, null, true],
    ['2xx with transport error', 200, 'incomplete response', false],
  ] as const
) {
  Deno.test(`${label}: retry without claiming delivery, then confirm recovery`, async () => {
    const db = await freshDb();
    try {
      await check(db);
      const first = await alert(db);
      await respond(db, status, error, timeout);
      assertEquals(await check(db), 0);
      const retried = await alert(db);
      assertEquals(retried.notified_at, null);
      assertNotEquals(retried.notification_request_id, first.notification_request_id);
      await respond(db, 200);
      assertEquals(await check(db), 1);
    } finally {
      await db.close();
    }
  });
}

Deno.test('a lost response is retried after the pending deadline', async () => {
  const db = await freshDb();
  try {
    await check(db);
    const first = await alert(db);
    await db.exec(
      "update public.indexer_alerts set notification_requested_at=now()-interval '6 minutes'",
    );
    assertEquals(await check(db), 0);
    assertNotEquals((await alert(db)).notification_request_id, first.notification_request_id);
    assertEquals((await alert(db)).notified_at, null);
  } finally {
    await db.close();
  }
});
