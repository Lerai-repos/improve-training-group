-- M2b — recommendation-engine tables.
--
--   * recommendation_generation: per-training monotonic counter (atomic allocation
--     of a run's `generation`, so a slow older run can never overwrite a newer one).
--   * recommendation_runs: the durable job + provenance + lifecycle record. A run is
--     enqueued synchronously before the webhook 200, claimed by a leased worker, and
--     driven queued → running → computed → delivered (or failed / superseded).
--   * recommendations: APPEND-ONLY, run-stamped history (unique per run, not per
--     training) so old runs stay reproducible from their stored input_artifact.
--   * current_recommendations: the latest DELIVERED run per training (a newer failed
--     run hides an older delivered one → empty). security_invoker + revoked.
--   * travel_cache: positive + short-negative Routes results, keyed by routing profile.
--
-- RLS deny-all on every table (mirror M1); the service-role worker bypasses RLS.

-- ---------------------------------------------------------------------------
-- Per-training generation counter (atomic allocation)
-- ---------------------------------------------------------------------------

create table recommendation_generation (
  training_external_id text primary key,
  next_gen             integer not null default 0
);

-- ---------------------------------------------------------------------------
-- Durable job + provenance + lifecycle
-- ---------------------------------------------------------------------------

create table recommendation_runs (
  id                        uuid primary key default gen_random_uuid(),
  -- Monday's per-delivery id — the idempotency key that dedups the 30-min retry storm.
  trigger_uuid              text not null unique,
  trigger_kind              text not null,                    -- 'group_move' | 'manual_button'
  monday_item_id            text not null,
  training_external_id      text not null,
  training_id               uuid references trainings (id),
  generation                integer not null,
  status                    text not null default 'queued',   -- queued|running|computed|delivered|failed|superseded
  -- Worker claim lease (compute phase).
  lease_owner               text,
  lease_expires_at          timestamptz,
  attempts                  integer not null default 0,
  -- Delivery lease (per-training serialization of the Monday write).
  delivery_lease_owner      text,
  delivery_lease_expires_at timestamptz,
  writeback_status          text,                             -- pending|delivered|failed
  writeback_attempts        integer not null default 0,
  writeback_error           text,
  -- Provenance.
  input_sync_run_id         uuid references sync_runs (id),
  input_artifact            jsonb,
  input_artifact_hash       text,
  monday_item_revision      text,
  ack_version               text,
  address_decision          jsonb,
  candidate_count           integer,
  eligible_count            integer,
  recommendation_count      integer,
  excluded_trainers         jsonb,
  provider_errors           jsonb,
  travel_cache_hits         integer,
  result_status             text,                             -- GEREED | GEEN MATCH | FOUT
  failing_stage             text,
  created_at                timestamptz not null default now(),
  started_at                timestamptz,
  finished_at               timestamptz
);
create index recommendation_runs_training_gen_idx on recommendation_runs (training_external_id, generation desc);
create index recommendation_runs_status_idx on recommendation_runs (status);

-- ---------------------------------------------------------------------------
-- Append-only, run-stamped recommendations
-- ---------------------------------------------------------------------------

create table recommendations (
  id                             uuid primary key default gen_random_uuid(),
  run_id                         uuid not null references recommendation_runs (id) on delete cascade,
  training_id                    uuid not null references trainings (id) on delete cascade,
  trainer_id                     uuid not null references trainers (id) on delete restrict,
  rank                           integer not null,
  billable_hours                 numeric(6, 2),
  hourly_rate_cents              integer,
  training_fee_cents             bigint,
  trainer_travel_cost_cents      bigint,
  -- Client-side charge: kept for the future iframe view, NOT part of total_cost_cents.
  client_travel_charge_cents     bigint,
  travel_time_compensation_cents bigint,
  total_cost_cents               bigint,
  round_trip_distance_km         numeric,
  hq_round_trip_distance_km      numeric,
  round_trip_duration_minutes    numeric,
  theme_avg_score                numeric,                     -- nullable (null sorts last)
  overall_avg_score              numeric,
  calculate_travel               boolean,
  created_at                     timestamptz not null default now(),
  unique (run_id, trainer_id)
);
create index recommendations_training_idx on recommendations (training_id);
create index recommendations_run_idx on recommendations (run_id);

-- ---------------------------------------------------------------------------
-- current_recommendations: rows of the MAX-generation run per training, and only
-- when that exact run is `delivered`. A newer failed/in-flight run (higher
-- generation, not delivered) hides an older delivered one → the view returns empty;
-- the FOUT/failed state is read separately from recommendation_runs.
--
-- security_invoker=true → the view runs with the caller's privileges, so the
-- underlying deny-all RLS applies; plus an explicit revoke (views otherwise run as
-- the owner and can leak past RLS).
-- ---------------------------------------------------------------------------

create view current_recommendations
  with (security_invoker = true) as
  select r.*
  from recommendations r
  join recommendation_runs run on run.id = r.run_id
  where run.status = 'delivered'
    and run.generation = (
      select max(run2.generation)
      from recommendation_runs run2
      where run2.training_external_id = run.training_external_id
    );

revoke all on current_recommendations from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- travel_cache: one-way Routes results, keyed by normalized addresses + routing
-- profile/version. `condition` is the Routes per-element outcome; a positive
-- (ROUTE_EXISTS) row is long-lived, a terminal-negative (ROUTE_NOT_FOUND) row is
-- short-TTL. Transient failures are NEVER cached (enforced in code).
-- ---------------------------------------------------------------------------

create table travel_cache (
  id               uuid primary key default gen_random_uuid(),
  origin_norm      text not null,
  destination_norm text not null,
  routing_key      text not null,                             -- provider + routingPreference + version
  condition        text not null,                             -- 'ROUTE_EXISTS' | 'ROUTE_NOT_FOUND'
  distance_km      numeric,                                   -- one-way; null for a negative row
  duration_minutes numeric,                                   -- one-way; null for a negative row
  fetched_at       timestamptz not null default now(),
  unique (origin_norm, destination_norm, routing_key)
);
create index travel_cache_fetched_idx on travel_cache (fetched_at);

-- ---------------------------------------------------------------------------
-- RLS deny-all (service-role worker bypasses).
-- ---------------------------------------------------------------------------

alter table recommendation_generation enable row level security;
alter table recommendation_runs       enable row level security;
alter table recommendations           enable row level security;
alter table travel_cache              enable row level security;
