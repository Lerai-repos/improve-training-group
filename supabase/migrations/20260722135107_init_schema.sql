-- M1 foundation schema — clean Postgres redesign of the fase-1 Airtable model.
--
-- Principles:
--   * Store raw facts + authoritative import snapshots only. Everything derived
--     (weighted avg, billable hours, travel, rankings) is computed in the TS calc
--     layer, never stored here.
--   * Internal uuid PKs; Monday ids are external identifiers, not keys.
--   * Multi-record relations via junction tables (a training can have several
--     trainers/themes/clients).
--   * RLS enabled + deny-all on every table; the service-role key (scripts/jobs)
--     bypasses RLS. Fine-grained policies land with the iframe/routes later.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

create type qualification as enum ('groen', 'oranje', 'rood', 'grijs');

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Masters
-- ---------------------------------------------------------------------------

create table trainers (
  id                uuid primary key default gen_random_uuid(),
  source_system     text not null default 'monday',
  external_item_id  text,
  external_board_id text,
  naam              text not null,
  adres             text,
  email             text,
  telefoon          text,
  -- Which rate schedule this trainer falls under (resolved against rate_cards).
  rate_key          text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source_system, external_item_id)
);

create table themas (
  id                uuid primary key default gen_random_uuid(),
  source_system     text not null default 'monday',
  external_item_id  text,
  external_board_id text,
  thema             text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source_system, external_item_id)
);

create table klanten (
  id                uuid primary key default gen_random_uuid(),
  source_system     text not null default 'monday',
  external_item_id  text,
  klantnaam         text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source_system, external_item_id)
);

-- ---------------------------------------------------------------------------
-- Hub: trainings (raw planning fields + imported evaluation snapshots)
-- ---------------------------------------------------------------------------

create table trainings (
  id                 uuid primary key default gen_random_uuid(),
  source_system      text not null default 'monday',
  external_item_id   text,
  external_board_id  text,
  external_group_id  text,

  -- Raw planning facts (from Monday)
  datum              date,
  tijd               text,
  taal               text,
  duur_training      numeric(6, 2),
  status             text,
  evaluatie_status   text,
  ie_code            text,
  omzet_cents        bigint,
  locatie            text,
  label              text,

  -- Imported evaluation aggregates (authoritative snapshots from Google Sheets).
  -- Every one carries the _snapshot suffix: this is imported data, not derived.
  avg_overall_grade_snapshot            numeric(4, 1),
  evaluation_count_snapshot             integer,
  avg_program_content_snapshot          numeric(4, 1),
  avg_practical_work_snapshot           numeric(4, 1),
  avg_concrete_tools_snapshot           numeric(4, 1),
  avg_trainer_competence_snapshot       numeric(4, 1),
  avg_trainer_communications_snapshot   numeric(4, 1),
  evaluation_snapshot_imported_at       timestamptz,
  evaluation_snapshot_revision          text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (source_system, external_item_id)
);

create index trainings_datum_idx on trainings (datum);

-- ---------------------------------------------------------------------------
-- Multi-record relations
--   training_id -> trainings ON DELETE CASCADE  (removing a training drops links)
--   master_id   -> master    ON DELETE RESTRICT (can't delete a master still in use)
-- ---------------------------------------------------------------------------

create table training_trainers (
  training_id uuid not null references trainings (id) on delete cascade,
  trainer_id  uuid not null references trainers (id) on delete restrict,
  created_at  timestamptz not null default now(),
  primary key (training_id, trainer_id)
);
create index training_trainers_trainer_idx on training_trainers (trainer_id);

create table training_themas (
  training_id uuid not null references trainings (id) on delete cascade,
  thema_id    uuid not null references themas (id) on delete restrict,
  created_at  timestamptz not null default now(),
  primary key (training_id, thema_id)
);
create index training_themas_thema_idx on training_themas (thema_id);

create table training_klanten (
  training_id uuid not null references trainings (id) on delete cascade,
  klant_id    uuid not null references klanten (id) on delete restrict,
  created_at  timestamptz not null default now(),
  primary key (training_id, klant_id)
);
create index training_klanten_klant_idx on training_klanten (klant_id);

-- Trainer×theme qualification (replaces Themas' color pulse-ID lists + junction
-- Qualification). One row per pairing; precedence on conflict handled in code.
create table trainer_theme_qualifications (
  id            uuid primary key default gen_random_uuid(),
  trainer_id    uuid not null references trainers (id) on delete cascade,
  thema_id      uuid not null references themas (id) on delete cascade,
  qualification qualification not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (trainer_id, thema_id)
);
create index ttq_thema_idx on trainer_theme_qualifications (thema_id);

-- ---------------------------------------------------------------------------
-- Config (non-financial key-value) + rate_cards (financial, effective-dated)
-- ---------------------------------------------------------------------------

create table config (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,
  value       text not null,
  description text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table rate_cards (
  id                uuid primary key default gen_random_uuid(),
  rate_key          text not null,
  -- null = default card for the whole rate_key; non-null = trainer-scoped override
  trainer_id        uuid references trainers (id) on delete cascade,
  valid_from        date not null,
  valid_until       date,               -- null = open-ended; exclusive upper bound
  hourly_rate_cents integer not null check (hourly_rate_cents >= 0),
  currency          text not null default 'EUR',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (valid_until is null or valid_until > valid_from),

  -- No two default cards for the same rate_key may overlap in time.
  constraint rate_cards_default_no_overlap exclude using gist (
    rate_key with =,
    daterange(valid_from, valid_until, '[)') with &&
  ) where (trainer_id is null),

  -- No two overrides for the same (rate_key, trainer) may overlap in time.
  constraint rate_cards_override_no_overlap exclude using gist (
    rate_key with =,
    trainer_id with =,
    daterange(valid_from, valid_until, '[)') with &&
  ) where (trainer_id is not null)
);
create index rate_cards_lookup_idx on rate_cards (rate_key, trainer_id);

create table label_config (
  id                     uuid primary key default gen_random_uuid(),
  label                  text not null unique,
  volledige_naam         text,
  kleur                  text,
  term                   text,
  rapportterm            text,
  logo_url               text,
  backpage_url           text,
  frontpage_url          text,
  evaluatieformulier_url text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create trigger trainers_set_updated_at before update on trainers
  for each row execute function set_updated_at();
create trigger themas_set_updated_at before update on themas
  for each row execute function set_updated_at();
create trigger klanten_set_updated_at before update on klanten
  for each row execute function set_updated_at();
create trigger trainings_set_updated_at before update on trainings
  for each row execute function set_updated_at();
create trigger ttq_set_updated_at before update on trainer_theme_qualifications
  for each row execute function set_updated_at();
create trigger config_set_updated_at before update on config
  for each row execute function set_updated_at();
create trigger rate_cards_set_updated_at before update on rate_cards
  for each row execute function set_updated_at();
create trigger label_config_set_updated_at before update on label_config
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: enable + deny-all on every table. No policies = no access for anon or
-- authenticated roles. The service-role key (scripts/jobs) bypasses RLS.
-- ---------------------------------------------------------------------------

alter table trainers                     enable row level security;
alter table themas                       enable row level security;
alter table klanten                      enable row level security;
alter table trainings                    enable row level security;
alter table training_trainers            enable row level security;
alter table training_themas              enable row level security;
alter table training_klanten             enable row level security;
alter table trainer_theme_qualifications enable row level security;
alter table config                       enable row level security;
alter table rate_cards                   enable row level security;
alter table label_config                 enable row level security;
