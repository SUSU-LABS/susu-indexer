-- Create indexer alerts table and monitoring functions

create table if not exists public.indexer_alerts (
    id uuid primary key default gen_random_uuid(),
    alert_type text not null,
    message text not null,
    created_at timestamp with time zone default now(),
    resolved_at timestamp with time zone
);

-- Function to check for failed pg_cron jobs
create or replace function public.check_failed_schedules()
returns void as $$
declare
    v_now timestamp with time zone := now();
    failure_window interval := interval '1 hour';
    r record;
begin
    -- We only alert on terminal failures (status = 'failed' and end_time is not null)
    -- to avoid false positives from in-flight 'running' jobs.
    for r in (
        select d.jobid, d.status, d.return_message, d.start_time
        from cron.job_run_details d
        where d.status = 'failed'
          and d.end_time is not null
          and d.start_time > v_now - failure_window
    ) loop
        insert into public.indexer_alerts (alert_type, message)
        values (
            'failed_schedule',
            'Cron job ' || r.jobid || ' failed with message: ' || coalesce(r.return_message, 'unknown error')
        );
    end loop;
end;
$$ language plpgsql;
