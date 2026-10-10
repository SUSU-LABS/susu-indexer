-- Susu Protocol — ledger lag alert
--
-- WHY THIS EXISTS
-- `check_indexer_health` watched three conditions: a stale checkpoint, failed
-- runs, and failed schedules. None of them sees a checkpoint that advances
-- steadily but slower than the chain. That checkpoint is never stale, yet the
-- distance to the chain tip grows every run, and Soroban RPC only serves events
-- from a rolling window (7 days on Testnet, about 120,000 ledgers at 5s per
-- ledger). Past that window the missing events are gone permanently — the
-- runbook calls the lag "the one number worth alerting on" and this migration
-- finally alerts on it.
--
-- WHAT IT ADDS
-- A fourth condition, `ledger_lag`, evaluated by the same `check_indexer_health`
-- the cron job already runs. The indexer persists the chain tip it observed on
-- every run (including runs that indexed nothing), and the check compares it
-- against the checkpoint. The threshold defaults to 60,000 ledgers — half the
-- retention window, about 3.5 days of lag — so the alert fires while catching
-- up is still possible, and it is a parameter so operators can tighten it.
-- The one-open-per-(kind,subject) machinery is untouched: a lag that persists
-- refreshes the open row's detail, and a lag that recovers resolves it.

-- ---------------------------------------------------------------------------
-- 1. The chain tip, as observed by the most recent indexer run.
-- ---------------------------------------------------------------------------
alter table public.indexer_checkpoints
  add column if not exists last_seen_latest_ledger bigint
    check (last_seen_latest_ledger >= 0);

comment on column public.indexer_checkpoints.last_seen_latest_ledger is
  'Chain tip observed by the most recent indexer run, including runs that indexed nothing. check_indexer_health compares it against last_processed_ledger to detect a growing lag before it reaches the RPC retention window.';

-- ---------------------------------------------------------------------------
-- 2. Admit the new alert kind.
--
-- The original migration declared this check inline, so PostgreSQL named it
-- indexer_alerts_kind_check. It is replaced, not patched, because a check
-- constraint cannot be edited in place.
-- ---------------------------------------------------------------------------
alter table public.indexer_alerts drop constraint indexer_alerts_kind_check;
alter table public.indexer_alerts
  add constraint indexer_alerts_kind_check
  check (kind in ('stale_checkpoint', 'failed_run', 'failed_schedule', 'ledger_lag'));

-- ---------------------------------------------------------------------------
-- 3. The check, with the lag condition.
--
-- SECURITY DEFINER and the fixed search_path are unchanged; see the original
-- migration for why both are load-bearing. Adding a parameter — even one with
-- a default — creates a new overload, and `select check_indexer_health()` would
-- then be ambiguous, so the old three-argument function is dropped first.
-- ---------------------------------------------------------------------------
drop function if exists public.check_indexer_health(interval, interval, boolean);

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

  -- Notify, once, per newly opened alert. A rollback after this point would
  -- send the same notification again on the next pass: at-least-once is the
  -- side to err on, because a duplicate is an annoyance and a miss is a lost
  -- window.
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
      and exists (select 1 from pg_namespace where nspname = 'net') then
      for v_alert in
        select a.id, a.kind, a.subject, a.detail
        from public.indexer_alerts a
        where a.resolved_at is null
          and a.notified_at is null
        order by a.opened_at
      loop
        perform net.http_post(
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
        );

        update public.indexer_alerts set notified_at = v_now where id = v_alert.id;
        v_notified := v_notified + 1;
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
  'Opens, refreshes and resolves indexer health alerts, including ledger lag. Idempotent: one open alert per condition, so it may run as often as anything likes.';

-- Only the scheduler and trusted server code run this; a browser never does.
revoke all on function public.check_indexer_health(interval, interval, boolean, bigint) from public;
revoke all on function public.check_indexer_health(interval, interval, boolean, bigint) from anon, authenticated;
grant execute on function public.check_indexer_health(interval, interval, boolean, bigint) to service_role;

-- The existing fifteen-minute schedule calls check_indexer_health() with no
-- arguments; the new parameter's default keeps that call working unchanged.
