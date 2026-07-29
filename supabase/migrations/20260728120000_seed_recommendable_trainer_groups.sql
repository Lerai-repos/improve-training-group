-- Which Monday trainer-board groups count toward recommendations is now CONFIG,
-- not a code constant (fase-2a: "selecteerbare trainergroepen ... niet hardcoded").
--
-- `supabase/seed.sql` only runs on `db reset`, so an already-provisioned environment
-- would never receive this row and would sit on the code default forever. Hence an
-- idempotent migration as well: `on conflict do nothing` means re-running is safe
-- and an operator's edited value is never reset back to the seeded default.
--
-- Value = comma-separated Monday group ids; the engine reads it via `getAppConfig`.
-- An empty value is rejected by the config schema (an empty selection would make
-- every training return GEEN MATCH — a config error that must fail loudly).

insert into config (key, value, description) values
  ('RECOMMENDABLE_TRAINER_GROUPS', 'topics,nieuwe_groep__1',
   'Monday trainer-board group ids that count toward recommendations (comma-separated)')
on conflict (key) do nothing;
