-- M2b — review hardening:
--   * read_recommendation_inputs also returns the latest OK sync's started_at, so
--     the engine can reject a too-old snapshot (freshness gate).
--   * finalize_delivery is fenced by the delivery-lease owner — after a lease
--     expires and another worker takes over, the original worker must NOT be able
--     to finalize (clearing the new lease / clobbering its writeback outcome).

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
    'sync_run_started_at', (
      select started_at from public.sync_runs where status = 'ok' order by started_at desc limit 1
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

-- Owner-fenced finalize (new arg → drop the old 3-arg overload first).
drop function if exists public.finalize_delivery(uuid, boolean, text);

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
  v_run    public.recommendation_runs;
  v_repair uuid;
begin
  select * into v_run from public.recommendation_runs where id = p_run_id;
  if not found then
    raise exception 'finalize_delivery: no run %', p_run_id;
  end if;

  -- Fence: only the current delivery-lease owner may finalize. A worker whose lease
  -- expired (and was taken over) is a no-op here.
  if v_run.delivery_lease_owner is distinct from p_owner then
    return jsonb_build_object('stale_owner', true, 'repair_run_id', null);
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

  select id into v_repair
    from public.recommendation_runs
    where training_external_id = v_run.training_external_id
      and generation > v_run.generation
      and status in ('computed', 'failed')
      and (writeback_status is distinct from 'delivered')
    order by generation desc
    limit 1;

  return jsonb_build_object('stale_owner', false, 'repair_run_id', v_repair);
end;
$$;

revoke all on function public.finalize_delivery(uuid, text, boolean, text) from public;
grant execute on function public.finalize_delivery(uuid, text, boolean, text) to service_role;
