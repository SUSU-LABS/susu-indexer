-- Derive a group's reconciled state with one aggregation per group instead of
-- re-reading every fact row.
--
-- `reconcileGroups` used to load all of a group's `group_members`,
-- `contributions`, `payouts`, `protocol_fees` and `decoded_events` rows on
-- every run and re-sum them in JavaScript. That cost grew with lifetime
-- history: a long-lived group eventually made each run approach the function
-- time budget. This function folds the same facts in Postgres and returns one
-- row per requested contract, so reconcile work is bounded by the number of
-- groups touched, not by the size of their histories.
--
-- The aggregates mirror `deriveGroupState` in
-- `supabase/functions/_shared/state.ts` field for field:
--   member_count      = COUNT(group_members)
--   current_round     = MAX(round) over contributions and payouts (0 when none)
--   completed_rounds  = MAX(round) over payouts (0 when none)
--   contributed_total / paid_out_total / fee_total = SUM(...), NULL folded to 0
--   started / completed = whether a `start` / `completed` event is on record
--   last_event_ledger = MAX(ledger) over decoded_events (0 when none)
--
-- Wide integers cross PostgREST as `text`: PostgREST renders `numeric` and
-- `bigint` as JSON numbers, and JavaScript silently rounds past 2^53. The
-- money columns are `numeric(39,0)` — integer-valued — so `SUM(...)::text` is
-- an exact digit string, the same shape `sumAmounts` in `state.ts` produces.
-- An empty set sums to NULL in Postgres; the COALESCE to '0' matches
-- `sumAmounts([]) === '0'`. `GREATEST` returns NULL when any argument is NULL,
-- hence the inner COALESCEs on the two MAX(round) subqueries.

create or replace function public.derive_group_state(p_contract_ids text[])
returns table (
  contract_id text,
  member_count text,
  current_round integer,
  completed_rounds integer,
  contributed_total text,
  paid_out_total text,
  fee_total text,
  started boolean,
  completed boolean,
  last_event_ledger text
)
language sql
stable
as $$
  select
    id as contract_id,
    (select count(*)::text
       from public.group_members m
      where m.contract_id = id) as member_count,
    greatest(
      coalesce((select max(c.round) from public.contributions c where c.contract_id = id), 0),
      coalesce((select max(p.round) from public.payouts p where p.contract_id = id), 0)
    ) as current_round,
    coalesce((select max(p.round) from public.payouts p where p.contract_id = id), 0)
      as completed_rounds,
    coalesce((select sum(c.amount)::text from public.contributions c where c.contract_id = id), '0')
      as contributed_total,
    coalesce((select sum(p.recipient_amount)::text from public.payouts p where p.contract_id = id), '0')
      as paid_out_total,
    coalesce((select sum(f.fee)::text from public.protocol_fees f where f.contract_id = id), '0')
      as fee_total,
    coalesce((select bool_or(e.name = 'start') from public.decoded_events e where e.contract_id = id), false)
      as started,
    coalesce((select bool_or(e.name = 'completed') from public.decoded_events e where e.contract_id = id), false)
      as completed,
    coalesce((select max(e.ledger)::text from public.decoded_events e where e.contract_id = id), '0')
      as last_event_ledger
  from unnest(p_contract_ids) as id;
$$;

comment on function public.derive_group_state(text[]) is
  'One-row-per-group aggregation of the fact tables for reconciliation. '
  'Replaces re-reading every fact row on each indexer run.';

-- The indexer calls this through PostgREST with the service-role key.
grant execute on function public.derive_group_state(text[]) to service_role;
