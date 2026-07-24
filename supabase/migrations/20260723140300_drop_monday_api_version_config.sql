-- Remove the now-obsolete MONDAY_API_VERSION config row from EXISTING databases.
--
-- The pinned Monday API version moved to a code constant (board-config
-- `MONDAY_API_VERSION`) as the single source of truth — dry-run is DB-free, so the
-- version can't come from the DB. `buildAppConfig` no longer reads this key, so a
-- leftover row is already inert; this deletes it so the config table doesn't keep a
-- stale/misleading `2025-04` value. No-op on a fresh reset (seed no longer inserts it).

delete from config where key = 'MONDAY_API_VERSION';
