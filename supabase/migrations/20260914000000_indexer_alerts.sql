-- Susu Protocol — indexer health alerts
--
-- WHY THIS EXISTS
-- The runbook calls the distance between the checkpoint and the chain tip "the
-- one number worth alerting on", and section 31 of the design document requires
-- alerts for a stale checkpoint, failed scheduled runs and abnormal errors.
-- Until this migration nothing alerted. `ledgerLag` was computed on every run
-- and returned in the function's own response, where nothing was reading it, so
-- a stopped indexer was visible only to a person who went looking for it.
--
-- That failure mode is worth stating precisely, because it is not a slow one.
-- Soroban RPC serves events from a rolling window. A checkpoint that falls far
-- enough behind crosses a deadline past which the missing events cannot be
-- fetched at any price, and the gap is permanent. Everything here exists to
-- notice long before that, while noticing is still cheap.
--
-- WHAT IT WATCHES
-- Three conditions, all read from state that already exists:
--
--   1. `stale_checkpoint` — the checkpoint has not advanced inside the window.
--      This is the actionable signal and it deliberately does not consult the
--      chain: a checkpoint that stops moving is how lag grows in the first
--      place, and this needs no RPC, no secret and no quota to evaluate.
--   2. `failed_run`       — the indexer recorded a failure. The newest reason
--      travels in the alert, because the reasons need different responses and
--      a validation fault must never be answered by loosening validation.
--   3. `failed_schedule`  — a scheduled invocation did not succeed. This covers
--      the class the run log cannot: runs that never started, or were rejected
--      before the indexer could record anything about them.
--
-- ONE ALERT PER CONDITION, NOT ONE PER CHECK
-- The check runs every fifteen minutes. An alert that fired on every pass would
-- be noise inside an hour and filtered away inside a day, which is how alerting
-- stops working. So a partial unique index permits exactly one open row per
-- (kind, subject); a condition that is still true refreshes that row's detail
-- rather than opening a second one; and a condition that clears resolves the row
-- rather than deleting it. The history stays readable: what broke, what it said,
-- and when it stopped.
--
-- SILENCE IS NOT HEALTH
-- If a URL is stored in Vault as `indexer_alert_webhook`, a newly opened alert
-- is posted there. If it is not stored, the alert is still recorded and nothing
-- is sent — so the table has to be looked at. An open alert with a null
-- `notified_at` is one that nobody was told about:
--
--   select kind, subject, detail, opened_at
--   from public.indexer_alerts
--   where resolved_at is null
--   order by opened_at desc;
--
-- This migration never disables RLS and grants nothing to a browser role.

-- ---------------------------------------------------------------------------
-- Alerts: one row per condition, open until it clears.
-- ---------------------------------------------------------------------------
create table if not exists public.indexer_alerts (
  id uuid primary key default gen_random_uuid(),
  -- Constrained rather than free text so a typo in the producer cannot quietly
  -- create a category that no operator query or future rule knows about.
  kind text not null check (kind in ('stale_checkpoint', 'failed_run', 'failed_schedule')),
  -- The thing the condition is about: the checkpoint, or a cron job by name.
  subject text not null,
  detail jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default now(),
  -- Set when the condition stopped being true. The row is kept.
  resolved_at timestamptz,
  -- Set when a notification was confirmed by the webhook: the queued
  -- `net.http_post` request has to come back 2xx before this is written, so a
  -- 404, a 500 or a timeout leaves it null and the next pass retries. Delivery
  -- is therefore at-least-once rather than exactly-once — a response that
  -- arrives just after the status is read can cause one repeat — and a
  -- duplicate is a far cheaper mistake than an alert nobody ever saw. Null on
  -- an open alert means recorded but not sent.
  notified_at timestamptz,
  constraint indexer_alerts_resolved_after_opened
    check (resolved_at is null or resolved_at >= opened_at)
);

comment on table public.indexer_alerts is
  'One row per indexer health condition, open until it clears. Open rows with a null notified_at are alerts nobody was told about.';

-- At most one open alert per condition. This is what makes detection idempotent:
-- the check can run as often as it likes and the result is the same single row.
create unique index if not exists indexer_alerts_open_idx
  on public.indexer_alerts (kind, subject)
  where resolved_at is null;

create index if not exists indexer_alerts_opened_at_idx
  on public.indexer_alerts (opened_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security: enabled, with no policies (deny by default).
-- ---------------------------------------------------------------------------
alter table public.indexer_alerts enable row level security;

-- ---------------------------------------------------------------------------
-- Grants: browser roles get nothing; RLS is not a substitute for grants.
-- ---------------------------------------------------------------------------
revoke all on public.indexer_alerts from anon, authenticated;

grant select, insert, update on public.indexer_alerts to service_role;

-- ---------------------------------------------------------------------------
-- The check.
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
  v_request_id bigint;
  v_status integer;
  v_delivered boolean := false;
  v_try integer;
begin
  -- The conditions that are true right now. A temp table rather than three
  -- repeated queries, because the same set is used to open alerts and then to
  -- decide which open alerts have cleared, and those two must agree exactly.
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
        v_request_id := net.http_post(
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

        -- `net.http_post` only queues the request: the id it returns is not a
        -- delivery confirmation. Read the response back before marking the
        -- alert delivered, so a 404, a 500 or a timeout leaves notified_at
        -- null and the next pass tries again. Delivery is at-least-once: a
        -- response that lands just after the read below yields a duplicate,
        -- which is an annoyance, while a missed alert is a lost window.
        v_delivered := false;
        v_try := 0;
        while v_try < 40 loop
          select r.status_code into v_status
          from net._http_response r
          where r.id = v_request_id
          limit 1;
          if found then
            v_delivered := v_status between 200 and 299;
            exit;
          end if;
          v_try := v_try + 1;
          perform pg_sleep(0.25);
        end loop;

        if v_delivered then
          update public.indexer_alerts set notified_at = v_now where id = v_alert.id;
          v_notified := v_notified + 1;
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

comment on function public.check_indexer_health(interval, interval, boolean) is
  'Opens, refreshes and resolves indexer health alerts. Idempotent: one open alert per condition, so it may run as often as anything likes.';

-- Only the scheduler and trusted server code run this; a browser never does.
revoke all on function public.check_indexer_health(interval, interval, boolean) from public;
revoke all on function public.check_indexer_health(interval, interval, boolean) from anon, authenticated;
grant execute on function public.check_indexer_health(interval, interval, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Schedule: every fifteen minutes.
--
-- Fifteen, against an indexer that runs every five: three consecutive missed
-- runs before anyone is told. Tight enough that a stopped indexer is noticed
-- while the fix is still trivial, loose enough that a single transient RPC
-- failure does not page anybody — the indexer retries those itself.
--
-- Guarded twice, because this migration has to apply in three different places:
-- a hosted project where it schedules, a hosted project where the applying role
-- may not write `cron.job`, and the CI guards' plain PostgreSQL where `cron`
-- does not exist at all. Only the first is silent; the other two say what to do.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'cron') then
    raise notice 'pg_cron is not installed: check_indexer_health was created but not scheduled. Schedule it by hand (see docs/RUNBOOK.md).';
    return;
  end if;

  begin
    if exists (select 1 from cron.job where jobname = 'susu-indexer-health') then
      perform cron.unschedule('susu-indexer-health');
    end if;

    perform cron.schedule(
      'susu-indexer-health',
      '*/15 * * * *',
      'select public.check_indexer_health();'
    );

    raise notice 'Scheduled susu-indexer-health every 15 minutes.';
  exception
    when insufficient_privilege then
      raise notice 'Not permitted to write cron.job: check_indexer_health was created but not scheduled. Schedule it as the project owner: select cron.schedule(''susu-indexer-health'', ''*/15 * * * *'', ''select public.check_indexer_health();'');';
  end;
end
$$;
