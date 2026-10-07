-- Susu Protocol — rejected events and alert monitoring
--
-- Persists chain events that the decoder could not recognise or parse so that
-- decoder misses and interface drift are durable and alertable rather than a
-- truncated log message.

create table if not exists public.rejected_events (
  event_identity text primary key,
  event_id text not null,
  reason text not null,
  ledger bigint not null check (ledger >= 0),
  tx_hash text not null,
  tx_index integer not null check (tx_index >= 0),
  event_index integer not null check (event_index >= 0),
  contract_id text not null,
  created_at timestamptz not null default now()
);

comment on table public.rejected_events is
  'Raw chain events that the decoder failed to recognise or parse. Rebuildable from chain history.';

create index if not exists rejected_events_ledger_idx
  on public.rejected_events (ledger);
create index if not exists rejected_events_contract_ledger_idx
  on public.rejected_events (contract_id, ledger);

alter table public.rejected_events enable row level security;
revoke all on public.rejected_events from anon, authenticated;
grant select, insert, update on public.rejected_events to service_role;

-- Extend indexer_alerts check constraint to support rejected_events alert kind
alter table public.indexer_alerts drop constraint if exists indexer_alerts_kind_check;
alter table public.indexer_alerts add constraint indexer_alerts_kind_check
  check (kind in ('stale_checkpoint', 'failed_run', 'failed_schedule', 'rejected_events'));
