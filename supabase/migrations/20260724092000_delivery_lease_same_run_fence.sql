-- M2b — review hardening (delivery lease):
--   The original acquire_delivery_lease busy-check excluded p_run_id, so two workers
--   delivering the SAME pending run both passed the check and both mutated Monday
--   (the second silently overwriting the first lease owner). Two fixes:
--     1. Re-read the run AFTER taking the advisory lock — the pre-lock read is stale
--        and would miss a lease a prior holder committed while we were blocked.
--     2. Reject the same run when it already carries an unexpired lease owned by
--        someone else (in addition to the existing other-run, per-training check).

create or replace function public.acquire_delivery_lease(p_run_id uuid, p_owner text, p_lease_seconds integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_training text;
  v_run      public.recommendation_runs;
  v_max      integer;
  v_busy     boolean;
begin
  select training_external_id into v_training
    from public.recommendation_runs where id = p_run_id;
  if not found then
    raise exception 'acquire_delivery_lease: no run %', p_run_id;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_training));

  -- Re-read AFTER the lock so a lease committed by a prior holder (while we were
  -- blocked on the advisory lock) is visible.
  select * into v_run from public.recommendation_runs where id = p_run_id;

  -- This run already holds an unexpired lease owned by a DIFFERENT worker → busy.
  -- (Previously the busy check excluded p_run_id entirely, so two workers on the
  -- same run both acquired and both wrote Monday.)
  if v_run.delivery_lease_expires_at is not null
     and v_run.delivery_lease_expires_at > now()
     and v_run.delivery_lease_owner is distinct from p_owner then
    return jsonb_build_object('acquired', false, 'reason', 'delivery_busy');
  end if;

  -- Another run of the same training holds an unexpired lease → serialize (busy).
  select exists (
    select 1 from public.recommendation_runs
    where training_external_id = v_training
      and id <> p_run_id
      and delivery_lease_expires_at is not null
      and delivery_lease_expires_at > now()
  ) into v_busy;
  if v_busy then
    return jsonb_build_object('acquired', false, 'reason', 'delivery_busy');
  end if;

  select max(generation) into v_max
    from public.recommendation_runs where training_external_id = v_training;
  if v_run.generation < v_max then
    update public.recommendation_runs
      set status = 'superseded'
      where id = p_run_id and status <> 'delivered';
    return jsonb_build_object('acquired', false, 'reason', 'superseded');
  end if;

  update public.recommendation_runs
    set delivery_lease_owner = p_owner,
        delivery_lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        writeback_status = 'pending'
    where id = p_run_id;
  return jsonb_build_object('acquired', true);
end;
$$;

revoke all on function public.acquire_delivery_lease(uuid, text, integer) from public;
grant execute on function public.acquire_delivery_lease(uuid, text, integer) to service_role;
