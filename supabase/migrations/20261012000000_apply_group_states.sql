-- Reconcile many groups in one round trip instead of one UPDATE per group.
--
-- `upsertGroupState` used to await one `UPDATE groups SET ... WHERE
-- contract_id = $1` per touched group, so a busy range multiplied latency and
-- failure surface by the number of reconciled groups. This function applies
-- the whole batch as a single `UPDATE ... FROM (jsonb values)` statement —
-- O(1) requests regardless of how many groups the run touched.
--
-- The "zero rows updated is an error" invariant is preserved exactly:
-- reconciliation updates groups that discovery already recorded and must
-- never create them, so a contract_id with no matching `groups` row raises
-- instead of silently writing a group with no identity.
--
-- Money columns arrive as `text` (the caller's wire shape, matching the
-- `::text` casts on the read side) and are cast back to `numeric(39,0)` here;
-- an unparseable value raises rather than rounding.

create or replace function public.apply_group_states(p_states jsonb)
returns integer
language plpgsql
as $$
declare
  applied integer;
begin
  update public.groups g
  set
    status = s.status,
    member_count = s.member_count,
    current_round = s.current_round,
    completed_rounds = s.completed_rounds,
    contributed_total = s.contributed_total,
    paid_out_total = s.paid_out_total,
    fee_total = s.fee_total,
    last_event_ledger = s.last_event_ledger,
    updated_at = now()
  from (
    select
      r ->> 'contract_id' as contract_id,
      r ->> 'status' as status,
      (r ->> 'member_count')::integer as member_count,
      (r ->> 'current_round')::integer as current_round,
      (r ->> 'completed_rounds')::integer as completed_rounds,
      (r ->> 'contributed_total')::numeric(39,0) as contributed_total,
      (r ->> 'paid_out_total')::numeric(39,0) as paid_out_total,
      (r ->> 'fee_total')::numeric(39,0) as fee_total,
      (r ->> 'last_event_ledger')::bigint as last_event_ledger
    from jsonb_array_elements(p_states) as r
  ) s
  where g.contract_id = s.contract_id;

  get diagnostics applied = row_count;

  if applied <> jsonb_array_length(p_states) then
    raise exception
      'no groups row for % state(s) — reconciliation updates existing groups, it never creates them',
      jsonb_array_length(p_states) - applied;
  end if;

  return applied;
end;
$$;
