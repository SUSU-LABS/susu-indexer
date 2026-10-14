-- At-least-once alert delivery.
--
-- pg_net's net.http_post only queues the request — the response lands in
-- net._http_response asynchronously. The previous function set notified_at
-- right after queueing, so a webhook that later failed (404/500/timeout) was
-- recorded as delivered and never retried. Now each request id is stored and
-- reconciled on the next pass: notified_at is stamped once, only after a
-- confirmed 2xx; a failure or a lost response clears the marker and the
-- alert re-sends. Delivery is at-least-once — a crash between confirm and
-- stamp may send the same alert again, which is the safe side.

alter table public.indexer_alerts
  add column if not exists notification_request_id bigint,
  add column if not exists notification_queued_at timestamptz;

comment on column public.indexer_alerts.notification_request_id is
  'The pg_net request id for the in-flight webhook delivery. Reconciled against net._http_response before notified_at is set — a missing or non-2xx response leaves the alert eligible for retry.';

comment on column public.indexer_alerts.notification_queued_at is
  'When the in-flight delivery was queued; a response still absent after the timeout is treated as lost and the alert re-sends.';

create or replace function public.check_indexer_health(
  stale_after interval default '30 minutes',
  failure_window interval default '1 hour',
  send_notifications boolean default true,
  lag_threshold_ledgers bigint default 60000
)
returns table (opened integer, resolved integer, open_now integer, notified integer)
language plpgsql
security definer
set search_path = public, extensions, vault
as $function$
declare
  v_now timestamptz := now();
  v_updated timestamptz;
  v_ledger bigint;
  v_last_seen bigint;
  v_before integer;
  v_after integer;
  v_resolved integer := 0;
  v_notified integer := 0;
  v_webhook text;
  v_alert record;
  v_status integer;
  v_request_id bigint;
begin
  -- The conditions that are true right now. A temp table rather than four
  -- repeated queries, because the same set is used to open alerts and then to
  -- decide which open alerts have cleared, and those two must agree exactly.
  drop table if exists pg_temp.indexer_conditions;
  create temp table indexer_conditions (kind text, subject text, detail jsonb) on commit drop;

  select c.updated_at, c.last_processed_ledger, c.last_seen_latest_ledger
    into v_updated, v_ledger, v_last_seen
  from public.indexer_checkpoints c
  where c.id = 'default';

  -- 1. A checkpoint that is stale, or that has never been written at all. The
  --    second is not the same condition as the first and says so in the detail,
  --    because "the indexer has never completed a run" and "the indexer stopped"
  --    are answered differently.
  if v_updated is null then
    insert into indexer_conditions (kind, subject, detail)
    values (
      'stale_checkpoint',
      'default',
      jsonb_build_object(
        'neverRan', true,
        'staleAfterSeconds', extract(epoch from stale_after)::bigint
      )
    );
  elsif v_updated < v_now - stale_after then
    insert into indexer_conditions (kind, subject, detail)
    values (
      'stale_checkpoint',
      'default',
      jsonb_build_object(
        'lastProcessedLedger', v_ledger,
        'checkpointUpdatedAt', v_updated,
        'secondsSinceCheckpoint', extract(epoch from (v_now - v_updated))::bigint,
        'staleAfterSeconds', extract(epoch from stale_after)::bigint
      )
    );
  end if;

  -- 2. Failures the indexer recorded. Only failures are written to the run log
  --    by design, so their absence here means the window was clean.
  insert into indexer_conditions (kind, subject, detail)
  select
    'failed_run',
    'default',
    jsonb_build_object(
      'failures', count(*),
      'newestReason', (array_agg(r.reason order by r.created_at desc))[1],
      'newestAt', max(r.created_at),
      'windowSeconds', extract(epoch from failure_window)::bigint
    )
  from public.indexer_runs r
  where r.status = 'failed'
    and r.created_at > v_now - failure_window
  having count(*) > 0;

  -- 3. Scheduled invocations that did not succeed. Guarded on the extension
  --    existing, so the migration applies to a plain PostgreSQL used by the CI
  --    guards, where `cron` is absent and these rows can never exist.
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    insert into indexer_conditions (kind, subject, detail)
    select
      'failed_schedule',
      j.jobname,
      jsonb_build_object(
        'failures', count(*),
        'newestMessage', left((array_agg(coalesce(d.return_message, '') order by d.start_time desc))[1], 200),
        'newestAt', max(d.start_time),
        'windowSeconds', extract(epoch from failure_window)::bigint
      )
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
    where d.status <> 'succeeded'
      and d.start_time > v_now - failure_window
    group by j.jobname
    having count(*) > 0;
  end if;

  -- 4. The checkpoint is moving but the chain is outrunning it. Staleness
  --    cannot see this: a checkpoint that advances on every run is never
  --    stale, yet the distance to the tip can grow without bound until the
  --    RPC's retention window closes over the gap and the missing events are
  --    gone for good. The threshold sits at half the window so this fires
  --    while catching up is still a matter of running, not rebuilding.
  --    A null last_seen_latest_ledger means no run has recorded the tip yet
  --    (pre-upgrade rows); there is nothing to compare, so there is no alert.
  if v_last_seen is not null and v_ledger is not null
    and (v_last_seen - v_ledger) > lag_threshold_ledgers then
    insert into indexer_conditions (kind, subject, detail)
    values (
      'ledger_lag',
      'default',
      jsonb_build_object(
        'lagLedgers', v_last_seen - v_ledger,
        'thresholdLedgers', lag_threshold_ledgers,
        'lastProcessedLedger', v_ledger,
        'lastSeenLatestLedger', v_last_seen
      )
    );
  end if;

  -- Open what is newly true, refresh what was already open. The difference in
  -- the count of open rows is exactly the number of new openings, which is
  -- cheaper and clearer than trying to distinguish an insert from an update.
  select count(*) into v_before from public.indexer_alerts where resolved_at is null;

  insert into public.indexer_alerts (kind, subject, detail)
  select kind, subject, detail from indexer_conditions
  on conflict (kind, subject) where resolved_at is null
  do update set detail = excluded.detail;

  select count(*) into v_after from public.indexer_alerts where resolved_at is null;

  -- Resolve what is no longer true.
  update public.indexer_alerts a
  set resolved_at = v_now
  where a.resolved_at is null
    and not exists (
      select 1 from indexer_conditions c
      where c.kind = a.kind and c.subject = a.subject
    );
  get diagnostics v_resolved = row_count;

  -- Deliver alerts at least once. pg_net queues the request and answers
  -- asynchronously into net._http_response, so notified_at may only be set
  -- after the delivery actually confirms 2xx. Phase 1 reconciles in-flight
  -- requests; phase 2 queues alerts that have neither a confirmation nor an
  -- in-flight request. A crash between confirm and stamp re-sends once —
  -- a duplicate is an annoyance, a miss is a lost window.
  if send_notifications then
    begin
      select s.decrypted_secret into v_webhook
      from vault.decrypted_secrets s
      where s.name = 'indexer_alert_webhook'
      limit 1;
    exception when others then
      -- No Vault, or no permission to read it. Alerts are still recorded; they
      -- are simply not delivered. See the note at the top: silence is not health.
      v_webhook := null;
    end;

    if v_webhook is not null
      and exists (select 1 from pg_namespace where nspname = 'net')
      and to_regclass('net._http_response') is not null then

      -- Phase 1: reconcile in-flight deliveries.
      for v_alert in
        select a.id, a.notification_request_id
        from public.indexer_alerts a
        where a.resolved_at is null
          and a.notification_request_id is not null
      loop
        select r.status_code into v_status
        from net._http_response r
        where r.id = v_alert.notification_request_id;

        if v_status is null then
          -- No response row yet — still in flight. Past the delivery timeout
          -- plus pg_net's own retention, an absent row means the delivery was
          -- lost: clear the marker so phase 2 re-sends.
          update public.indexer_alerts
            set notification_request_id = null
            where id = v_alert.id
              and notification_queued_at < v_now - interval '15 minutes';
        elsif v_status >= 200 and v_status < 300 then
          update public.indexer_alerts
            set notified_at = v_now,
                notification_request_id = null
            where id = v_alert.id;
          v_notified := v_notified + 1;
        else
          -- Non-2xx: the delivery attempt failed. Clear the marker so phase 2
          -- re-queues it on this pass.
          update public.indexer_alerts
            set notification_request_id = null
            where id = v_alert.id;
        end if;
      end loop;

      -- Phase 2: queue deliveries for alerts nobody has been told about.
      for v_alert in
        select a.id, a.kind, a.subject, a.detail
        from public.indexer_alerts a
        where a.resolved_at is null
          and a.notified_at is null
          and a.notification_request_id is null
        order by a.opened_at
      loop
        select net.http_post(
          url := v_webhook,
          headers := jsonb_build_object('content-type', 'application/json'),
          body := jsonb_build_object(
            'content',
            format(
              'Susu indexer alert — %s (%s) at %s: %s',
              v_alert.kind,
              v_alert.subject,
              to_char(v_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
              v_alert.detail::text
            )
          ),
          timeout_milliseconds := 10000
        ) into v_request_id;

        update public.indexer_alerts
          set notification_request_id = v_request_id,
              notification_queued_at = v_now
          where id = v_alert.id;
      end loop;
    end if;
  end if;

  opened := v_after - v_before;
  resolved := v_resolved;
  open_now := (select count(*)::integer from public.indexer_alerts where resolved_at is null);
  notified := v_notified;
  return next;
end;
$function$;

comment on function public.check_indexer_health(interval, interval, boolean, bigint) is
  'Opens, refreshes and resolves indexer health alerts, then delivers them at least once: a webhook is queued via pg_net and notified_at is stamped only after the delivery confirms 2xx — failures re-send on the next pass. Idempotent: one open alert per condition, so it may run as often as anything likes.';
