-- M2a — domain-model changes the live Monday sync needs somewhere to persist.
--
--   * trainers.monday_group: the raw Monday group id, stored on EVERY trainer
--     (ingestion is never filtered by rate/recommendation eligibility).
--   * trainers.rate_key made NULLABLE: an unmapped-group trainer must still import;
--     rate is a downstream policy decision, not a sync-blocking requirement.
--   * Qualifications split into raw OBSERVATIONS (all colours, conflicts preserved)
--     vs one EFFECTIVE green/red decision per pair. Only groen/rood auto-map;
--     oranje/grijs leave effective NULL + flagged (their mapping is not confirmed).

-- Effective (post-migration) 2-state qualification consumed by the M2b calc layer.
create type effective_qualification as enum ('green', 'red');

-- ---------------------------------------------------------------------------
-- Trainers: raw group + nullable rate_key
-- ---------------------------------------------------------------------------

alter table trainers add column monday_group text;
alter table trainers alter column rate_key drop not null;

-- ---------------------------------------------------------------------------
-- Raw colour observations — one row per (trainer, thema, colour), so a pair
-- listed under two colours keeps BOTH observations (exact source preservation).
-- ---------------------------------------------------------------------------

create table trainer_theme_qual_observations (
  id            uuid primary key default gen_random_uuid(),
  trainer_id    uuid not null references trainers (id) on delete cascade,
  thema_id      uuid not null references themas (id) on delete cascade,
  colour        qualification not null,
  source_column text,
  created_at    timestamptz not null default now(),
  unique (trainer_id, thema_id, colour)
);
create index ttqo_thema_idx   on trainer_theme_qual_observations (thema_id);
create index ttqo_trainer_idx on trainer_theme_qual_observations (trainer_id);

-- ---------------------------------------------------------------------------
-- Repurpose trainer_theme_qualifications as the EFFECTIVE decision (one per pair).
-- Backfill observations + effective from existing rows, then drop the raw column.
-- ---------------------------------------------------------------------------

alter table trainer_theme_qualifications
  add column effective_qualification effective_qualification;
alter table trainer_theme_qualifications
  add column conflict_resolution jsonb;

-- Preserve existing M1 raw colours as observations.
insert into trainer_theme_qual_observations (trainer_id, thema_id, colour, source_column)
  select trainer_id, thema_id, qualification, 'm1_backfill'
  from trainer_theme_qualifications
  on conflict (trainer_id, thema_id, colour) do nothing;

-- Auto-map only the unambiguous colours; oranje/grijs stay NULL (unconfirmed).
update trainer_theme_qualifications
  set effective_qualification = case qualification
    when 'groen' then 'green'::effective_qualification
    when 'rood'  then 'red'::effective_qualification
    else null
  end;

alter table trainer_theme_qualifications drop column qualification;

-- ---------------------------------------------------------------------------
-- RLS deny-all on the new table (mirror M1's contract).
-- ---------------------------------------------------------------------------

alter table trainer_theme_qual_observations enable row level security;
