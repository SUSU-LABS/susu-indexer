-- Susu Protocol — confirm alert webhook delivery before marking notified_at
--
-- WHY THIS EXISTS
-- `check_indexer_health` queued each alert with `net.http_post` and then
-- unconditionally set `notified_at = v_now`. Because `net.http_post` only
-- enqueues a request and returns a request id, any webhook that later failed
-- (404/500/timeout) was marked as notified and never retried.
--
-- WHAT IT ADDS
-- 1. `notification_request_id` column on `indexer_alerts` to track in-flight pg_net requests.
-- 2. `check_indexer_health` reconciles `notification_request_id` against `net._http_response`:
--    - Sets `notified_at` only on confirmed 2xx HTTP response status.
--    - Clears `notification_request_id` on non-2xx response or network error so the next pass retries.
--    - Leaves pending in-flight requests untouched until completion (at-least-once delivery).

-- ---------------------------------------------------------------------------
-- 1. Add notification_request_id column to indexer_alerts.
-- ---------------------------------------------------------------------------
alter table public.indexer_alerts
  add column if not exists notification_request_id bigint;

comment on column public.indexer_alerts.notification_request_id is
  'pg_net request id for in-flight or last attempted webhook delivery. Reconciled against net._http_response before marking notified_at.';

-- ---------------------------------------------------------------------------
-- 2. Update check_indexer_health function.
-- ---------------------------------------------------------------------------
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
  v_req_id bigint;
  v_status integer;
  v_error text;
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

  -- 1. A checkpoint that is stale, or that has never been written at all.
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

  -- 2. Failures the indexer recorded.
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

  -- 3. Scheduled invocations that did not succeed.
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

  -- 4. Ledger lag condition.
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

  -- Open what is newly true, refresh what was already open.
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

  -- Notify with at-least-once semantics: mark notified_at only after confirmed 2xx.
  if send_notifications then
    begin
      select s.decrypted_secret into v_webhook
      from vault.decrypted_secrets s
      where s.name = 'indexer_alert_webhook'
      limit 1;
    exception when others then
      v_webhook := null;
    end;

    if v_webhook is not null
      and exists (select 1 from pg_namespace where nspname = 'net') then

      -- Step A: Reconcile in-flight webhook responses
      if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'net' and c.relname = '_http_response') then
        for v_alert in
          select a.id, a.notification_request_id
          from public.indexer_alerts a
          where a.notified_at is null
            and a.notification_request_id is not null
        loop
          execute 'select status_code, error_msg from net._http_response where id = $1'
            into v_status, v_error
            using v_alert.notification_request_id;

          if v_status is not null or v_error is not null then
            if v_status >= 200 and v_status < 300 then
              update public.indexer_alerts set notified_at = v_now where id = v_alert.id;
              v_notified := v_notified + 1;
            else
              -- Failed/non-2xx response: clear request_id so it will be retried
              update public.indexer_alerts set notification_request_id = null where id = v_alert.id;
            end if;
          end if;
        end loop;
      end if;

      -- Step B: Queue notifications for un-notified alerts
      for v_alert in
        select a.id, a.kind, a.subject, a.detail
        from public.indexer_alerts a
        where a.resolved_at is null
          and a.notified_at is null
          and a.notification_request_id is null
        order by a.opened_at
      loop
        execute 'select net.http_post(
          url := $1,
          headers := jsonb_build_object(''content-type'', ''application/json''),
          body := jsonb_build_object(
            ''content'',
            format(
              ''Susu indexer alert — %s (%s) at %s: %s'',
              $2,
              $3,
              to_char($4 at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS"Z"''),
              $5::text
            )
          ),
          timeout_milliseconds := 10000
        )'
          into v_req_id
          using v_webhook, v_alert.kind, v_alert.subject, v_now, v_alert.detail;

        update public.indexer_alerts
        set notification_request_id = v_req_id
        where id = v_alert.id;

        -- Check if immediate response is recorded
        if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'net' and c.relname = '_http_response') then
          execute 'select status_code, error_msg from net._http_response where id = $1'
            into v_status, v_error
            using v_req_id;

          if v_status is not null or v_error is not null then
            if v_status >= 200 and v_status < 300 then
              update public.indexer_alerts set notified_at = v_now where id = v_alert.id;
              v_notified := v_notified + 1;
            else
              update public.indexer_alerts set notification_request_id = null where id = v_alert.id;
            end if;
          end if;
        end if;
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
  'Opens, refreshes and resolves indexer health alerts, with at-least-once webhook delivery reconciled against net._http_response.';

revoke all on function public.check_indexer_health(interval, interval, boolean, bigint) from public;
revoke all on function public.check_indexer_health(interval, interval, boolean, bigint) from anon, authenticated;
grant execute on function public.check_indexer_health(interval, interval, boolean, bigint) to service_role;
