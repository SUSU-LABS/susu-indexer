-- ---------------------------------------------------------------------------
-- Bulk group-state reconciliation.
--
-- `IndexerDb.upsertGroupState` used to issue one UPDATE per group. A range
-- that touches many groups multiplied latency and failure surface on every
-- run. This function writes all of them in a single statement and reports
-- which contract_ids had no `groups` row, so the caller can still fail
-- loudly instead of silently creating half-populated rows.
--
-- An UPDATE, not an upsert, and the distinction is not stylistic. Postgres
-- checks a row's `NOT NULL` constraints on the tuple an `INSERT` proposes,
-- *before* it resolves an `ON CONFLICT` against an existing row. `groups`
-- carries the group's identity as `NOT NULL` columns with no defaults, and
-- reconciliation only knows derived figures. So an upsert fails on the first
-- row with `null value in column "factory_contract_id"` even though the
-- conflicting row exists and holds every one of those values.
-- ---------------------------------------------------------------------------
create or replace function public.reconcile_group_states(p_states jsonb)
returns text[]
language plpgsql
set search_path = public
as $function$
declare
  v_missing text[];
begin
  with s as (
    select *
    from jsonb_to_recordset(p_states) as x(
      contract_id text,
      status text,
      member_count integer,
      current_round integer,
      completed_rounds integer,
      contributed_total numeric(39, 0),
      paid_out_total numeric(39, 0),
      fee_total numeric(39, 0),
      last_event_ledger bigint,
      updated_at timestamptz
    )
  ),
  upd as (
    update public.groups g
    set status = s.status,
        member_count = s.member_count,
        current_round = s.current_round,
        completed_rounds = s.completed_rounds,
        contributed_total = s.contributed_total,
        paid_out_total = s.paid_out_total,
        fee_total = s.fee_total,
        last_event_ledger = s.last_event_ledger,
        updated_at = s.updated_at
    from s
    where g.contract_id = s.contract_id
    returning g.contract_id
  )
  select coalesce(array_agg(s.contract_id), '{}')
    into v_missing
  from s
  left join upd on upd.contract_id = s.contract_id
  where upd.contract_id is null;

  return v_missing;
end
$function$;

comment on function public.reconcile_group_states(jsonb) is
  'Bulk UPDATE of derived group state. Returns the contract_ids that had no groups row; the caller treats a non-empty result as an error.';

grant execute on function public.reconcile_group_states(jsonb) to service_role;
