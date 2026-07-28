-- M2b — review hardening round 3:
--   * finalize_delivery: the owner fence was a separate SELECT, then both UPDATEs
--     filtered by id only → a worker whose lease expired could, after a new worker
--     took over, clear the new lease and finalize anyway (TOCTOU). Make it atomic:
--     the UPDATE itself filters on delivery_lease_owner = p_owner and we act on the
--     affected row count. Exactly one authoritative statement, no check/act gap.
--   * claim_recommendation_run_by_id: lease a SPECIFIC run (for the parity / once
--     scripts, which must claim the run they just enqueued — not the oldest queued
--     run, which with a backlog would compute a different training).

create or replace function public.finalize_delivery(
  p_run_id uuid,
  p_owner text,
  p_success boolean,
  p_error text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_training   text;
  v_generation integer;
  v_repair     uuid;
  v_n          integer;
begin
  select training_external_id, generation into v_training, v_generation
    from public.recommendation_runs where id = p_run_id;
  if not found then
    raise exception 'finalize_delivery: no run %', p_run_id;
  end if;

  -- Atomic fence: the owner predicate is IN the update, so a run taken over by a
  -- new owner matches zero rows here — the stale worker can neither clear the new
  -- lease nor mark the stale write delivered.
  if p_success then
    update public.recommendation_runs
      set status = case when status = 'failed' then 'failed' else 'delivered' end,
          writeback_status = 'delivered',
          writeback_attempts = writeback_attempts + 1,
          delivery_lease_owner = null,
          delivery_lease_expires_at = null,
          finished_at = now()
      where id = p_run_id and delivery_lease_owner = p_owner;
  else
    update public.recommendation_runs
      set writeback_status = 'failed',
          writeback_attempts = writeback_attempts + 1,
          writeback_error = p_error,
          delivery_lease_owner = null,
          delivery_lease_expires_at = null
      where id = p_run_id and delivery_lease_owner = p_owner;
  end if;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('stale_owner', true, 'repair_run_id', null);
  end if;

  select id into v_repair
    from public.recommendation_runs
    where training_external_id = v_training
      and generation > v_generation
      and status in ('computed', 'failed')
      and (writeback_status is distinct from 'delivered')
    order by generation desc
    limit 1;

  return jsonb_build_object('stale_owner', false, 'repair_run_id', v_repair);
end;
$$;

revoke all on function public.finalize_delivery(uuid, text, boolean, text) from public;
grant execute on function public.finalize_delivery(uuid, text, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- claim_recommendation_run_by_id — lease ONE named run (queued, or a 'running' run
-- whose lease expired). Empty set when the run isn't claimable. Same lifecycle as
-- claim_recommendation_run, but targeted (used by the scripts that enqueue then
-- immediately process their own run).
-- ---------------------------------------------------------------------------

create or replace function public.claim_recommendation_run_by_id(
  p_run_id uuid,
  p_owner text,
  p_lease_seconds integer
)
returns setof public.recommendation_runs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  update public.recommendation_runs
    set status = 'running',
        lease_owner = p_owner,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        attempts = attempts + 1,
        started_at = coalesce(started_at, now())
  where id = p_run_id
    and (status = 'queued'
         or (status = 'running' and lease_expires_at is not null and lease_expires_at < now()))
  returning *;
end;
$$;

revoke all on function public.claim_recommendation_run_by_id(uuid, text, integer) from public;
grant execute on function public.claim_recommendation_run_by_id(uuid, text, integer) to service_role;
