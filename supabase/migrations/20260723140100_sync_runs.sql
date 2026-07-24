-- M2a — durable run manifest + tombstone (soft-delete) columns.
--
--   * sync_runs: the authoritative record of every APPLY run (dry-run is DB-free
--     and writes only a local manifest). Created before preflight, finalized in a
--     `finally` path, so early-stage aborts are still recorded. Survives the
--     snapshot purge and is queryable by the future M2c cron.
--   * deleted_at tombstones: reconciliation soft-removes records absent from the
--     authoritative source scope (never hard-delete), preserving eval history +
--     historical FKs; a reappearing record clears its tombstone.

create table sync_runs (
  id                 uuid primary key default gen_random_uuid(),
  mode               text not null,                       -- 'apply' (dry-run never writes here)
  status             text not null default 'running',     -- running | ok | failed
  scope              jsonb not null,                       -- { boardId, ... }
  target             text,                                 -- resolved non-prod DB target
  schema_hash        text,
  config_hash        text,
  artifact_hash      text,
  artifact_counts    jsonb,                                -- per-section counts
  board_totals       jsonb,
  anomalies          jsonb,                                -- severity-classified
  monday_request_ids jsonb,
  failing_stage      text,
  started_at         timestamptz not null default now(),
  finished_at        timestamptz
);
create index sync_runs_started_idx on sync_runs (started_at desc);

-- Tombstone columns (soft-delete) on trainings + every master.
alter table trainings add column deleted_at timestamptz;
alter table trainers  add column deleted_at timestamptz;
alter table themas    add column deleted_at timestamptz;
alter table klanten   add column deleted_at timestamptz;

-- RLS deny-all (mirror M1's contract).
alter table sync_runs enable row level security;
