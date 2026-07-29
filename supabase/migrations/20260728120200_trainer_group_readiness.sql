-- Per-trainer-group readiness, so an operator can see BEFORE selecting a group
-- whether picking it would actually do anything.
--
-- The counts are deliberately INTERSECTION-based. "n trainers have a rate" AND
-- "m trainers are green" says nothing useful — they can be different people. What
-- matters is: how many green-qualified trainers can actually be PRICED, because
-- only those can ever be recommended.
--
-- Rate resolvability mirrors lib/calc/rate-resolution.ts exactly: a trainer-scoped
-- override (rate_cards.trainer_id = the trainer's uuid) or the rate_key default
-- (trainer_id is null), with valid_from inclusive and valid_until exclusive against
-- p_ref_date. Note trainer_id is a UUID — matching it against a Monday external id
-- would silently never resolve.
--
-- Returns the latest OK sync too: these counts come from the M2a snapshot while the
-- group TITLES are read live from Monday, so the caller must be able to refuse to
-- report when the snapshot is missing or stale rather than mixing the two silently.

create or replace function public.trainer_group_readiness(p_ref_date date)
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
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object(
        'monday_group', g.monday_group,
        'trainers', g.trainers,
        'green_trainers', g.green_trainers,
        'green_with_resolvable_rate', g.green_with_rate,
        'green_without_rate', g.green_trainers - g.green_with_rate
      ))
      from (
        select
          tr.monday_group,
          count(*) as trainers,
          count(*) filter (
            where exists (
              select 1 from public.trainer_theme_qualifications q
              where q.trainer_id = tr.id and q.effective_qualification = 'green'
            )
          ) as green_trainers,
          count(*) filter (
            where exists (
              select 1 from public.trainer_theme_qualifications q
              where q.trainer_id = tr.id and q.effective_qualification = 'green'
            )
            and tr.rate_key is not null
            and exists (
              select 1 from public.rate_cards rc
              where rc.rate_key = tr.rate_key
                and (rc.trainer_id is null or rc.trainer_id = tr.id)
                and p_ref_date >= rc.valid_from
                and (rc.valid_until is null or p_ref_date < rc.valid_until)
            )
          ) as green_with_rate
        from public.trainers tr
        where tr.deleted_at is null and tr.monday_group is not null
        group by tr.monday_group
      ) g
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.trainer_group_readiness(date) from public;
grant execute on function public.trainer_group_readiness(date) to service_role;
