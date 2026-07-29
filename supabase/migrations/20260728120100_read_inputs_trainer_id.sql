-- read_recommendation_inputs also returns the trainer's INTERNAL uuid.
--
-- Why: `rate_cards.trainer_id` is a uuid, but the engine was resolving rates with
-- the Monday `external_item_id`. Those identities can never be equal, so
-- trainer-scoped rate overrides silently never applied — every trainer fell through
-- to the rate_key default. Invisible so far only because no override rows exist.
-- Carrying `tr.id` lets pricing match overrides correctly, and keeps the readiness
-- RPC (which joins on the uuid) in agreement with what a run actually does.
--
-- Otherwise identical to 20260724091000 (which added sync_run_started_at).

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
        'id', tr.id,
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
