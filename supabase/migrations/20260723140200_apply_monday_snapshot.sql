-- M2a — single atomic apply RPC. Applies one validated artifact in ONE
-- transaction: verify-against-run-record → upsert masters/trainings → reconcile
-- junctions + qualifications (delete-by-scope + insert) → tombstone absent
-- records → in-transaction count verify (RAISE rolls the whole run back).
--
-- Security: SECURITY INVOKER (called by the service role, which bypasses RLS),
-- fixed empty search_path (all refs schema-qualified), EXECUTE restricted to the
-- service role. No generic p_table — one typed function.

-- Canonical content hash of an artifact. Both the caller (when staging the run
-- record) and the apply RPC compute md5(jsonb::text) — jsonb normalizes key order
-- + whitespace, so the same artifact yields the same hash and a DIFFERENT artifact
-- (even same section sizes) yields a different one.
create or replace function public.jsonb_content_md5(p jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$ select md5(p::text) $$;

revoke all on function public.jsonb_content_md5(jsonb) from public;
grant execute on function public.jsonb_content_md5(jsonb) to service_role;

create or replace function public.apply_monday_snapshot(p_run_id uuid, p_artifact jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_run     public.sync_runs;
  v_board   text := p_artifact -> 'scope' ->> 'boardId';
  v_counts  jsonb := p_artifact -> 'counts';
  v_n       integer;
  v_tomb    integer;
begin
  -- 1. Bind to the run record: scope + declared counts must match, and each
  --    section's actual length must equal its declared count (catches truncation).
  select * into v_run from public.sync_runs where id = p_run_id;
  if not found then
    raise exception 'apply_monday_snapshot: no sync_runs row %', p_run_id;
  end if;
  -- The run must be freshly-open: this closes replay of a different (same-sized)
  -- artifact under an already-finalized run id.
  if v_run.status is distinct from 'running' then
    raise exception 'apply_monday_snapshot: run % is not running (status=%)', p_run_id, v_run.status;
  end if;
  if v_run.scope is distinct from (p_artifact -> 'scope') then
    raise exception 'apply_monday_snapshot: scope mismatch vs sync_runs';
  end if;
  if v_run.artifact_counts is distinct from v_counts then
    raise exception 'apply_monday_snapshot: counts mismatch vs sync_runs';
  end if;
  if v_board is null then
    raise exception 'apply_monday_snapshot: missing scope.boardId';
  end if;
  if (p_artifact ->> 'schemaVersion') is distinct from '1' then
    raise exception 'apply_monday_snapshot: unsupported artifact schemaVersion %', p_artifact ->> 'schemaVersion';
  end if;
  -- Content binding: the payload must be byte-identical to the one staged on the
  -- run record — a different artifact (even same section sizes) is rejected.
  if v_run.artifact_hash is null or v_run.artifact_hash is distinct from public.jsonb_content_md5(p_artifact) then
    raise exception 'apply_monday_snapshot: artifact hash mismatch vs sync_runs';
  end if;

  -- Section-length == declared-count guard.
  perform 1 where
    jsonb_array_length(coalesce(p_artifact -> 'trainers', '[]'::jsonb))          = (v_counts ->> 'trainers')::int
    and jsonb_array_length(coalesce(p_artifact -> 'themas', '[]'::jsonb))        = (v_counts ->> 'themas')::int
    and jsonb_array_length(coalesce(p_artifact -> 'klanten', '[]'::jsonb))       = (v_counts ->> 'klanten')::int
    and jsonb_array_length(coalesce(p_artifact -> 'trainings', '[]'::jsonb))     = (v_counts ->> 'trainings')::int
    and jsonb_array_length(coalesce(p_artifact -> 'training_trainers','[]'::jsonb)) = (v_counts ->> 'training_trainers')::int
    and jsonb_array_length(coalesce(p_artifact -> 'training_themas','[]'::jsonb))   = (v_counts ->> 'training_themas')::int
    and jsonb_array_length(coalesce(p_artifact -> 'training_klanten','[]'::jsonb))  = (v_counts ->> 'training_klanten')::int
    and jsonb_array_length(coalesce(p_artifact -> 'qual_observations','[]'::jsonb)) = (v_counts ->> 'qual_observations')::int
    and jsonb_array_length(coalesce(p_artifact -> 'qual_effective','[]'::jsonb))    = (v_counts ->> 'qual_effective')::int;
  if not found then
    raise exception 'apply_monday_snapshot: a section length does not match its declared count';
  end if;

  -- 2. Upsert masters. IS DISTINCT FROM (incl. deleted_at) so an unchanged active
  --    row is untouched, but a reappearing (tombstoned) row is un-tombstoned.
  insert into public.trainers
    (source_system, external_item_id, external_board_id, naam, adres, email, telefoon, monday_group, rate_key, deleted_at)
  select 'monday', x.external_item_id, x.external_board_id, x.naam, x.adres, x.email, x.telefoon, x.monday_group, x.rate_key, null
  from jsonb_to_recordset(coalesce(p_artifact -> 'trainers', '[]'::jsonb))
    as x(external_item_id text, external_board_id text, naam text, adres text, email text,
         telefoon text, monday_group text, rate_key text)
  on conflict (source_system, external_item_id) do update
    set external_board_id = excluded.external_board_id, naam = excluded.naam, adres = excluded.adres,
        email = excluded.email, telefoon = excluded.telefoon, monday_group = excluded.monday_group,
        rate_key = excluded.rate_key, deleted_at = null
  where (public.trainers.external_board_id, public.trainers.naam, public.trainers.adres, public.trainers.email,
         public.trainers.telefoon, public.trainers.monday_group, public.trainers.rate_key, public.trainers.deleted_at)
     is distinct from
        (excluded.external_board_id, excluded.naam, excluded.adres, excluded.email,
         excluded.telefoon, excluded.monday_group, excluded.rate_key, null);

  insert into public.themas (source_system, external_item_id, external_board_id, thema, deleted_at)
  select 'monday', x.external_item_id, x.external_board_id, x.thema, null
  from jsonb_to_recordset(coalesce(p_artifact -> 'themas', '[]'::jsonb))
    as x(external_item_id text, external_board_id text, thema text)
  on conflict (source_system, external_item_id) do update
    set external_board_id = excluded.external_board_id, thema = excluded.thema, deleted_at = null
  where (public.themas.external_board_id, public.themas.thema, public.themas.deleted_at)
     is distinct from (excluded.external_board_id, excluded.thema, null);

  insert into public.klanten (source_system, external_item_id, klantnaam, deleted_at)
  select 'monday', x.external_item_id, x.klantnaam, null
  from jsonb_to_recordset(coalesce(p_artifact -> 'klanten', '[]'::jsonb))
    as x(external_item_id text, klantnaam text)
  on conflict (source_system, external_item_id) do update
    set klantnaam = excluded.klantnaam, deleted_at = null
  where (public.klanten.klantnaam, public.klanten.deleted_at)
     is distinct from (excluded.klantnaam, null);

  -- 3. Upsert trainings (planning columns only; never eval snapshots).
  insert into public.trainings
    (source_system, external_item_id, external_board_id, external_group_id, datum, tijd, taal,
     duur_training, status, ie_code, omzet_cents, locatie, label, deleted_at)
  select 'monday', x.external_item_id, x.external_board_id, x.external_group_id, x.datum, x.tijd, x.taal,
         x.duur_training, x.status, x.ie_code, x.omzet_cents, x.locatie, x.label, null
  from jsonb_to_recordset(coalesce(p_artifact -> 'trainings', '[]'::jsonb))
    as x(external_item_id text, external_board_id text, external_group_id text, datum date, tijd text,
         taal text, duur_training numeric, status text, ie_code text, omzet_cents bigint, locatie text, label text)
  on conflict (source_system, external_item_id) do update
    set external_board_id = excluded.external_board_id, external_group_id = excluded.external_group_id,
        datum = excluded.datum, tijd = excluded.tijd, taal = excluded.taal, duur_training = excluded.duur_training,
        status = excluded.status, ie_code = excluded.ie_code, omzet_cents = excluded.omzet_cents,
        locatie = excluded.locatie, label = excluded.label, deleted_at = null
  where (public.trainings.external_board_id, public.trainings.external_group_id, public.trainings.datum,
         public.trainings.tijd, public.trainings.taal, public.trainings.duur_training, public.trainings.status,
         public.trainings.ie_code, public.trainings.omzet_cents, public.trainings.locatie, public.trainings.label,
         public.trainings.deleted_at)
     is distinct from
        (excluded.external_board_id, excluded.external_group_id, excluded.datum, excluded.tijd, excluded.taal,
         excluded.duur_training, excluded.status, excluded.ie_code, excluded.omzet_cents, excluded.locatie,
         excluded.label, null);

  -- 4. Tombstone trainings on this board that are absent from the pull, and clear
  --    their junctions (a soft-deleted training keeps no live links).
  with pull as (
    select value ->> 'external_item_id' as ext
    from jsonb_array_elements(coalesce(p_artifact -> 'trainings', '[]'::jsonb))
  ), stale as (
    select id from public.trainings
    where source_system = 'monday' and external_board_id = v_board and deleted_at is null
      and external_item_id not in (select ext from pull)
  )
  update public.trainings set deleted_at = now()
  where id in (select id from stale);
  delete from public.training_trainers where training_id in (
    select id from public.trainings where source_system='monday' and external_board_id = v_board and deleted_at is not null
  );
  delete from public.training_themas where training_id in (
    select id from public.trainings where source_system='monday' and external_board_id = v_board and deleted_at is not null
  );
  delete from public.training_klanten where training_id in (
    select id from public.trainings where source_system='monday' and external_board_id = v_board and deleted_at is not null
  );

  -- 5. Tombstone masters absent from their full pull (never hard-delete).
  update public.trainers set deleted_at = now()
  where source_system='monday' and deleted_at is null
    and external_item_id not in (
      select value ->> 'external_item_id' from jsonb_array_elements(coalesce(p_artifact -> 'trainers','[]'::jsonb)));
  update public.themas set deleted_at = now()
  where source_system='monday' and deleted_at is null
    and external_item_id not in (
      select value ->> 'external_item_id' from jsonb_array_elements(coalesce(p_artifact -> 'themas','[]'::jsonb)));
  update public.klanten set deleted_at = now()
  where source_system='monday' and deleted_at is null
    and external_item_id not in (
      select value ->> 'external_item_id' from jsonb_array_elements(coalesce(p_artifact -> 'klanten','[]'::jsonb)));

  -- 6. Reconcile junctions: delete-by-scope (this board's active trainings) + insert.
  delete from public.training_trainers where training_id in (
    select id from public.trainings where source_system='monday' and external_board_id = v_board and deleted_at is null);
  insert into public.training_trainers (training_id, trainer_id)
  select tr.id, t.id
  from jsonb_to_recordset(coalesce(p_artifact -> 'training_trainers','[]'::jsonb)) as x(training_ext text, trainer_ext text)
  join public.trainings tr on tr.source_system='monday' and tr.external_item_id = x.training_ext
  join public.trainers  t  on t.source_system='monday'  and t.external_item_id  = x.trainer_ext;
  get diagnostics v_n = row_count;
  if v_n <> (v_counts ->> 'training_trainers')::int then
    raise exception 'apply_monday_snapshot: unresolved training_trainers ref (inserted %, expected %)',
      v_n, (v_counts ->> 'training_trainers')::int;
  end if;

  delete from public.training_themas where training_id in (
    select id from public.trainings where source_system='monday' and external_board_id = v_board and deleted_at is null);
  insert into public.training_themas (training_id, thema_id)
  select tr.id, th.id
  from jsonb_to_recordset(coalesce(p_artifact -> 'training_themas','[]'::jsonb)) as x(training_ext text, thema_ext text)
  join public.trainings tr on tr.source_system='monday' and tr.external_item_id = x.training_ext
  join public.themas    th on th.source_system='monday' and th.external_item_id = x.thema_ext;
  get diagnostics v_n = row_count;
  if v_n <> (v_counts ->> 'training_themas')::int then
    raise exception 'apply_monday_snapshot: unresolved training_themas ref (inserted %, expected %)',
      v_n, (v_counts ->> 'training_themas')::int;
  end if;

  delete from public.training_klanten where training_id in (
    select id from public.trainings where source_system='monday' and external_board_id = v_board and deleted_at is null);
  insert into public.training_klanten (training_id, klant_id)
  select tr.id, k.id
  from jsonb_to_recordset(coalesce(p_artifact -> 'training_klanten','[]'::jsonb)) as x(training_ext text, klant_ext text)
  join public.trainings tr on tr.source_system='monday' and tr.external_item_id = x.training_ext
  join public.klanten   k  on k.source_system='monday'  and k.external_item_id  = x.klant_ext;
  get diagnostics v_n = row_count;
  if v_n <> (v_counts ->> 'training_klanten')::int then
    raise exception 'apply_monday_snapshot: unresolved training_klanten ref (inserted %, expected %)',
      v_n, (v_counts ->> 'training_klanten')::int;
  end if;

  -- 7. Reconcile qualifications within the authoritative trainer scope (synced
  --    trainers): delete both observation + effective rows, then insert.
  delete from public.trainer_theme_qual_observations where trainer_id in (
    select id from public.trainers where source_system='monday' and external_item_id in (
      select value ->> 'external_item_id' from jsonb_array_elements(coalesce(p_artifact -> 'trainers','[]'::jsonb))));
  insert into public.trainer_theme_qual_observations (trainer_id, thema_id, colour, source_column)
  select t.id, th.id, x.colour, x.source_column
  from jsonb_to_recordset(coalesce(p_artifact -> 'qual_observations','[]'::jsonb))
    as x(trainer_ext text, thema_ext text, colour public.qualification, source_column text)
  join public.trainers t  on t.source_system='monday'  and t.external_item_id  = x.trainer_ext
  join public.themas   th on th.source_system='monday' and th.external_item_id = x.thema_ext;
  get diagnostics v_n = row_count;
  if v_n <> (v_counts ->> 'qual_observations')::int then
    raise exception 'apply_monday_snapshot: unresolved qual_observations ref (inserted %, expected %)',
      v_n, (v_counts ->> 'qual_observations')::int;
  end if;

  delete from public.trainer_theme_qualifications where trainer_id in (
    select id from public.trainers where source_system='monday' and external_item_id in (
      select value ->> 'external_item_id' from jsonb_array_elements(coalesce(p_artifact -> 'trainers','[]'::jsonb))));
  insert into public.trainer_theme_qualifications (trainer_id, thema_id, effective_qualification, conflict_resolution)
  select t.id, th.id, x.effective, x.conflict_resolution
  from jsonb_to_recordset(coalesce(p_artifact -> 'qual_effective','[]'::jsonb))
    as x(trainer_ext text, thema_ext text, effective public.effective_qualification, conflict_resolution jsonb)
  join public.trainers t  on t.source_system='monday'  and t.external_item_id  = x.trainer_ext
  join public.themas   th on th.source_system='monday' and th.external_item_id = x.thema_ext;
  get diagnostics v_n = row_count;
  if v_n <> (v_counts ->> 'qual_effective')::int then
    raise exception 'apply_monday_snapshot: unresolved qual_effective ref (inserted %, expected %)',
      v_n, (v_counts ->> 'qual_effective')::int;
  end if;

  -- 8. In-transaction verify: active row counts must equal the artifact counts.
  --    Any mismatch RAISES → the whole apply rolls back (never committed-then-flagged).
  select count(*) into v_n from public.trainings
    where source_system='monday' and external_board_id = v_board and deleted_at is null;
  if v_n <> (v_counts ->> 'trainings')::int then
    raise exception 'verify: active trainings % != artifact %', v_n, (v_counts ->> 'trainings')::int;
  end if;

  select count(*) into v_tomb from public.trainings
    where source_system='monday' and external_board_id = v_board and deleted_at is not null;

  -- Finalize the run record INSIDE this transaction, so 'ok' is atomic with the
  -- data (a crash after commit can't leave the row stuck at 'running').
  update public.sync_runs set status = 'ok', finished_at = now() where id = p_run_id;

  return jsonb_build_object(
    'run_id', p_run_id,
    'board', v_board,
    'applied', v_counts,
    'tombstoned_trainings', v_tomb
  );
end;
$$;

revoke all on function public.apply_monday_snapshot(uuid, jsonb) from public;
grant execute on function public.apply_monday_snapshot(uuid, jsonb) to service_role;
