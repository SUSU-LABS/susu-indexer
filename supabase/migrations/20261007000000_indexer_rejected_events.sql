-- Susu Protocol — persist and alert on rejected (unrecognised) chain events
--
-- WHY THIS EXISTS
-- `decodeChainEvents` returns the events it could not recognise in a `rejected`
-- list, and the indexer did nothing with it beyond logging the first five
-- reasons. Nothing was persisted and nothing was alerted on, so a decoder miss
-- — which by design means the contract interface moved, and can hide a real
-- contribution or payout — advanced the checkpoint in silence. Once past a
-- ledger, a Soroban RPC rolling window can make that event permanently
-- unfetchable. A truncated log line is not a durable record of it.
--
-- WHAT THIS DOES
--   1. Adds `indexer_rejected_events`: one row per rejected event, carrying the
--      chain identity and coordinates needed to locate it on chain, plus the
--      reason. The indexer writes here before it may advance the checkpoint.
--   2. Extends `check_indexer_health` with a `rejected_events` condition, so a
--      rejection inside the failure window opens (and later resolves) an alert
--      the same way a failed run does.
--
-- This migration never disables RLS and grants nothing to a browser role.

-- ---------------------------------------------------------------------------
-- Rejected events: durable records of raw events the decoder refused.
-- ---------------------------------------------------------------------------
create table if not exists public.indexer_rejected_events (
  -- The RPC paging token for the event: unique and stable, so re-reading a
  -- range cannot duplicate a rejection.
  event_id text primary key,
  correlation_id text not null,
  ledger bigint not null check (ledger >= 0),
  tx_hash text not null,
  tx_index integer not null check (tx_index >= 0),
  event_index integer not null check (event_index >= 0),
  contract_id text not null,
  -- Truncated decoder reason. Must never contain credentials.
  reason text not null,
  created_at timestamptz not null default now()
);

comment on table public.indexer_rejected_events is
  'Raw Soroban events the decoder did not recognise, with reason and chain coordinates. A decoder miss can hide a real contribution or payout, so these are durable and alertable rather than logged and forgotten.';

create index if not exists indexer_rejected_events_created_at_idx
  on public.indexer_rejected_events (created_at desc);
create index if not exists indexer_rejected_events_contract_ledger_idx
  on public.indexer_rejected_events (contract_id, ledger);

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled, with no policies (deny by default).
-- ---------------------------------------------------------------------------
alter table public.indexer_rejected_events enable row level security;

-- ---------------------------------------------------------------------------
-- Grants: browser roles get nothing; RLS is not a substitute for grants.
-- ---------------------------------------------------------------------------
revoke all on public.indexer_rejected_events from anon, authenticated;

grant select, insert, update on public.indexer_rejected_events to service_role;

-- ---------------------------------------------------------------------------
-- Alerts: allow a `rejected_events` condition alongside the existing kinds.
-- ---------------------------------------------------------------------------
alter table public.indexer_alerts drop constraint if exists indexer_alerts_kind_check;
alter table public.indexer_alerts add constraint indexer_alerts_kind_check
  check (kind in ('stale_checkpoint', 'failed_run', 'failed_schedule', 'rejected_events'));

-- ---------------------------------------------------------------------------
-- The check, redefined to add the rejected-events condition.
--
-- SECURITY DEFINER, and that is load-bearing rather than incidental: it reads
-- `cron.job_run_details` and `vault.decrypted_secrets`, which `service_role`
-- cannot read for itself. The fixed `search_path` is the price of definer rights
-- and is not optional — a definer function with a caller-controlled search_path
-- is how a definer function becomes a privilege escalation.
-- ---------------------------------------------------------------------------
create or replace function public.check_indexer_health(
  stale_after interval default '30 minutes',
  failure_window interval default '1 hour',
  send_notifications boolean default true
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
  v_before integer;
  v_after integer;
  v_resolved integer := 0;
  v_notified integer := 0;
  v_webhook text;
  v_alert record;
begin
  -- The conditions that are true right now. A temp table rather than repeated
  -- queries, because the same set is used to open alerts and then to decide
  -- which open alerts have cleared, and those two must agree exactly.
  drop table if exists pg_temp.indexer_conditions;
  create temp table indexer_conditions (kind text, subject text, detail jsonb) on commit drop;

  select c.updated_at, c.last_processed_ledger
    into v_updated, v_ledger
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

  -- 3. Events the decoder rejected. This is the durable, alertable form of the
  --    old truncated log line: an unrecognised event means the interface moved,
  --    and it can hide a real contribution or payout, so it must be noticed
  --    while the affected ledgers are still fetchable.
  insert into indexer_conditions (kind, subject, detail)
  select
    'rejected_events',
    'default',
    jsonb_build_object(
      'rejected', count(*),
      'newestReason', (array_agg(e.reason order by e.created_at desc))[1],
      'newestAt', max(e.created_at),
      'windowSeconds', extract(epoch from failure_window)::bigint
    )
  from public.indexer_rejected_events e
  where e.created_at > v_now - failure_window
  having count(*) > 0;

  -- 4. Scheduled invocations that did not succeed. Guarded on the extension
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

comment on function public.check_indexer_health(interval, interval, boolean) is
  'Opens, refreshes and resolves indexer health alerts. Idempotent: one open alert per condition, so it may run as often as anything likes.';

-- Only the scheduler and trusted server code run this; a browser never does.
revoke all on function public.check_indexer_health(interval, interval, boolean) from public;
revoke all on function public.check_indexer_health(interval, interval, boolean) from anon, authenticated;
grant execute on function public.check_indexer_health(interval, interval, boolean) to service_role;
