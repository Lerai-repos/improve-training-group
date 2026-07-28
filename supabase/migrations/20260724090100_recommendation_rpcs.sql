-- M2b — recommendation-engine RPCs (SECURITY INVOKER, fixed empty search_path,
-- EXECUTE restricted to service_role). Mirrors the M2a apply_monday_snapshot
-- contract: verify-against-run, atomic finalize, RAISE-on-mismatch rolls back.

-- ---------------------------------------------------------------------------
-- enqueue_recommendation_run — synchronous, called before the webhook 200.
-- Dedups Monday's retry storm on trigger_uuid; allocates a per-training generation
-- ATOMICALLY via the counter upsert (concurrent distinct triggers get distinct
-- generations). Returns the (new or existing) run.
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_recommendation_run(
  p_trigger_uuid text,
  p_trigger_kind text,
  p_monday_item_id text
)
returns public.recommendation_runs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.recommendation_runs;
  v_gen      integer;
  v_row      public.recommendation_runs;
begin
  select * into v_existing from public.recommendation_runs where trigger_uuid = p_trigger_uuid;
  if found then
    return v_existing;                                   -- dedup (idempotent)
  end if;

  insert into public.recommendation_generation (training_external_id, next_gen)
    values (p_monday_item_id, 1)
    on conflict (training_external_id)
      do update set next_gen = public.recommendation_generation.next_gen + 1
    returning next_gen into v_gen;

  insert into public.recommendation_runs
    (trigger_uuid, trigger_kind, monday_item_id, training_external_id, generation, status)
  values
    (p_trigger_uuid, p_trigger_kind, p_monday_item_id, p_monday_item_id, v_gen, 'queued')
  returning * into v_row;
  return v_row;
exception when unique_violation then
  -- A concurrent insert of the same trigger_uuid won; return the winner. The
  -- caught exception rolls back this block's counter increment, so no generation is burnt.
  select * into v_existing from public.recommendation_runs where trigger_uuid = p_trigger_uuid;
  return v_existing;
end;
$$;

revoke all on function public.enqueue_recommendation_run(text, text, text) from public;
grant execute on function public.enqueue_recommendation_run(text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- claim_recommendation_run — atomically lease the oldest queued run (or reclaim a
-- stuck 'running' one whose lease expired) → 'running'. `skip locked` prevents two
-- workers grabbing the same row. Returns null when nothing is claimable.
-- ---------------------------------------------------------------------------

create or replace function public.claim_recommendation_run(p_owner text, p_lease_seconds integer)
returns setof public.recommendation_runs
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- setof (0 or 1 rows) — a composite-returning function serializes RETURN NULL as
  -- an all-null object, which is indistinguishable from a real row; an empty set is not.
  return query
  update public.recommendation_runs
    set status = 'running',
        lease_owner = p_owner,
        lease_expires_at = now() + make_interval(secs => p_lease_seconds),
        attempts = attempts + 1,
        started_at = coalesce(started_at, now())
  where id = (
    select id from public.recommendation_runs
    where status = 'queued'
       or (status = 'running' and lease_expires_at is not null and lease_expires_at < now())
    order by created_at asc
    limit 1
    for update skip locked
  )
  returning *;
end;
$$;

revoke all on function public.claim_recommendation_run(text, integer) from public;
grant execute on function public.claim_recommendation_run(text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- read_recommendation_inputs — ONE coherent (single-statement) read of the
-- trainer master (recommendable cohort, not tombstoned) + eval-snapshot rows for
-- scoring + the latest OK sync id. Correctness-critical qualification membership is
-- live-read from Monday (not here). Trainer master is bounded-staleness by design.
-- ---------------------------------------------------------------------------

create or replace function public.read_recommendation_inputs(p_groups text[])
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'sync_run_id', (
      select id from public.sync_runs where status = 'ok' order by started_at desc limit 1
    ),
    'trainers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'external_item_id', tr.external_item_id,
        'naam', tr.naam,
        'adres', tr.adres,
        'monday_group', tr.monday_group,
        'rate_key', tr.rate_key
      ))
      from public.trainers tr
      where tr.deleted_at is null and tr.monday_group = any(p_groups)
    ), '[]'::jsonb),
    'trainer_theme_evals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'trainer_ext', tr.external_item_id,
        'thema_ext', th.external_item_id,
        'avg_overall_grade', tg.avg_overall_grade_snapshot,
        'evaluation_count', tg.evaluation_count_snapshot
      ))
      from public.trainings tg
      join public.training_trainers ttr on ttr.training_id = tg.id
      join public.trainers tr on tr.id = ttr.trainer_id
      join public.training_themas tth on tth.training_id = tg.id
      join public.themas th on th.id = tth.thema_id
      where tr.deleted_at is null and tr.monday_group = any(p_groups)
        and tg.deleted_at is null and tg.evaluation_count_snapshot is not null
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.read_recommendation_inputs(text[]) from public;
grant execute on function public.read_recommendation_inputs(text[]) to service_role;

-- ---------------------------------------------------------------------------
-- eligible_trainers_for_training — SNAPSHOT ORACLE (tests/parity only). Production
-- eligibility is the live TypeScript path. Requires the training to HAVE themes
-- (zero-theme → none) and the trainer to be effective-green for EVERY theme.
-- ---------------------------------------------------------------------------

create or replace function public.eligible_trainers_for_training(p_training_id uuid, p_groups text[])
returns setof public.trainers
language sql
stable
security invoker
set search_path = ''
as $$
  select tr.*
  from public.trainers tr
  where tr.deleted_at is null
    and tr.monday_group = any(p_groups)
    and exists (select 1 from public.training_themas tt where tt.training_id = p_training_id)
    and not exists (
      select 1 from public.training_themas tt
      where tt.training_id = p_training_id
        and not exists (
          select 1 from public.trainer_theme_qualifications q
          where q.trainer_id = tr.id
            and q.thema_id = tt.thema_id
            and q.effective_qualification = 'green'
        )
    );
$$;

revoke all on function public.eligible_trainers_for_training(uuid, text[]) from public;
grant execute on function public.eligible_trainers_for_training(uuid, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- apply_recommendations — generation compare-and-set (stale → superseded), append
-- the ranked rows (unresolved trainer ref → RAISE rolls back), finalize `computed`.
-- The run must be 'running'. result_status GEREED/GEEN MATCH is set here; FOUT is a
-- worker decision, never routed through this insert path.
-- ---------------------------------------------------------------------------

create or replace function public.apply_recommendations(
  p_run_id uuid,
  p_training_id uuid,
  p_generation integer,
  p_recs jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run      public.recommendation_runs;
  v_max      integer;
  v_n        integer;
  v_expected integer := jsonb_array_length(coalesce(p_recs, '[]'::jsonb));
begin
  select * into v_run from public.recommendation_runs where id = p_run_id;
  if not found then
    raise exception 'apply_recommendations: no run %', p_run_id;
  end if;
  if v_run.status is distinct from 'running' then
    raise exception 'apply_recommendations: run % not running (status=%)', p_run_id, v_run.status;
  end if;

  -- Generation CAS: a newer generation for this training wins; this run is stale.
  select max(generation) into v_max
    from public.recommendation_runs where training_external_id = v_run.training_external_id;
  if p_generation < v_max then
    update public.recommendation_runs
      set status = 'superseded', finished_at = now() where id = p_run_id;
    return jsonb_build_object('superseded', true, 'run_id', p_run_id);
  end if;

  delete from public.recommendations where run_id = p_run_id;   -- idempotent on retry
  insert into public.recommendations (
    run_id, training_id, trainer_id, rank, billable_hours, hourly_rate_cents, training_fee_cents,
    trainer_travel_cost_cents, client_travel_charge_cents, travel_time_compensation_cents, total_cost_cents,
    round_trip_distance_km, hq_round_trip_distance_km, round_trip_duration_minutes,
    theme_avg_score, overall_avg_score, calculate_travel)
  select p_run_id, p_training_id, t.id, x.rank, x.billable_hours, x.hourly_rate_cents, x.training_fee_cents,
    x.trainer_travel_cost_cents, x.client_travel_charge_cents, x.travel_time_compensation_cents, x.total_cost_cents,
    x.round_trip_distance_km, x.hq_round_trip_distance_km, x.round_trip_duration_minutes,
    x.theme_avg_score, x.overall_avg_score, x.calculate_travel
  from jsonb_to_recordset(coalesce(p_recs, '[]'::jsonb)) as x(
    trainer_ext text, rank integer, billable_hours numeric, hourly_rate_cents integer, training_fee_cents bigint,
    trainer_travel_cost_cents bigint, client_travel_charge_cents bigint, travel_time_compensation_cents bigint,
    total_cost_cents bigint, round_trip_distance_km numeric, hq_round_trip_distance_km numeric,
    round_trip_duration_minutes numeric, theme_avg_score numeric, overall_avg_score numeric, calculate_travel boolean)
  join public.trainers t on t.source_system = 'monday' and t.external_item_id = x.trainer_ext;
  get diagnostics v_n = row_count;
  if v_n <> v_expected then
    raise exception 'apply_recommendations: unresolved trainer ref (inserted %, expected %)', v_n, v_expected;
  end if;

  update public.recommendation_runs
    set status = 'computed',
        recommendation_count = v_expected,
        result_status = case when v_expected > 0 then 'GEREED' else 'GEEN MATCH' end,
        finished_at = now()
    where id = p_run_id;

  return jsonb_build_object('run_id', p_run_id, 'count', v_expected, 'superseded', false);
end;
$$;

revoke all on function public.apply_recommendations(uuid, uuid, integer, jsonb) from public;
grant execute on function public.apply_recommendations(uuid, uuid, integer, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- acquire_delivery_lease — serialize the Monday write per training (advisory lock
-- makes the check-and-set atomic) + fence on the latest generation. Returns
-- {acquired:true} to proceed, else {acquired:false, reason}. A stale run is marked
-- superseded (unless already delivered).
-- ---------------------------------------------------------------------------

create or replace function public.acquire_delivery_lease(p_run_id uuid, p_owner text, p_lease_seconds integer)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run public.recommendation_runs;
  v_max integer;
  v_busy boolean;
begin
  select * into v_run from public.recommendation_runs where id = p_run_id;
  if not found then
    raise exception 'acquire_delivery_lease: no run %', p_run_id;
  end if;

  perform pg_advisory_xact_lock(hashtext(v_run.training_external_id));

  select exists (
    select 1 from public.recommendation_runs
    where training_external_id = v_run.training_external_id
      and id <> p_run_id
      and delivery_lease_expires_at is not null
      and delivery_lease_expires_at > now()
  ) into v_busy;
  if v_busy then
    return jsonb_build_object('acquired', false, 'reason', 'delivery_busy');
  end if;

  select max(generation) into v_max
    from public.recommendation_runs where training_external_id = v_run.training_external_id;
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

-- ---------------------------------------------------------------------------
-- finalize_delivery — after the Monday write: record the outcome, release the
-- delivery lease, and post-write recheck the latest generation → return
-- `repair_run_id` if a newer run now needs (re)delivery (eventual convergence).
-- A computed run → delivered on success; a failed (FOUT) run stays failed but its
-- writeback is marked delivered.
-- ---------------------------------------------------------------------------

create or replace function public.finalize_delivery(p_run_id uuid, p_success boolean, p_error text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run    public.recommendation_runs;
  v_repair uuid;
begin
  select * into v_run from public.recommendation_runs where id = p_run_id;
  if not found then
    raise exception 'finalize_delivery: no run %', p_run_id;
  end if;

  if p_success then
    update public.recommendation_runs
      set status = case when status = 'failed' then 'failed' else 'delivered' end,
          writeback_status = 'delivered',
          writeback_attempts = writeback_attempts + 1,
          delivery_lease_owner = null,
          delivery_lease_expires_at = null,
          finished_at = now()
      where id = p_run_id;
  else
    update public.recommendation_runs
      set writeback_status = 'failed',
          writeback_attempts = writeback_attempts + 1,
          writeback_error = p_error,
          delivery_lease_owner = null,
          delivery_lease_expires_at = null
      where id = p_run_id;
  end if;

  -- A newer generation that has finished computing/failing but is not delivered → repair.
  select id into v_repair
    from public.recommendation_runs
    where training_external_id = v_run.training_external_id
      and generation > v_run.generation
      and status in ('computed', 'failed')
      and (writeback_status is distinct from 'delivered')
    order by generation desc
    limit 1;

  return jsonb_build_object('repair_run_id', v_repair);
end;
$$;

revoke all on function public.finalize_delivery(uuid, boolean, text) from public;
grant execute on function public.finalize_delivery(uuid, boolean, text) to service_role;
