-- Baseline config + rate cards (known fase-1 values). Applied on `supabase db reset`.
-- These are ITG-owned settings that will later be sourced from Monday boards.

insert into config (key, value, description) values
  ('HQ_ADRES', 'Wolvenplein 25, Utrecht', 'HQ address — client travel origin'),
  ('THRESHOLD_HOURS', '4', 'Minimum training hours to count for evaluation'),
  ('TRAVEL_RATE_TRAINER_CENTS_PER_KM', '23', 'Trainer travel payout per km (cents)'),
  ('TRAVEL_RATE_CLIENT_CENTS_PER_KM', '45', 'Client travel charge per km (cents)'),
  ('TRAVEL_TIME_THRESHOLD_MINUTES', '90', 'Free travel-time minutes before compensation'),
  ('TRAVEL_TIME_MODE', 'per_minute', 'Travel-time comp mode: per_minute | hourly_rate (OPEN question)'),
  ('TRAVEL_TIME_FEE_PER_MINUTE_CENTS', '100', 'Travel-time fee per minute (cents) — legacy €1/min'),
  ('RECOMMENDABLE_TRAINER_GROUPS', 'topics,nieuwe_groep__1',
   'Monday trainer-board group ids that count toward recommendations (comma-separated)')
-- NOTE: the pinned Monday API version is intentionally NOT config — it lives in
-- board-config `MONDAY_API_VERSION` (single source of truth; dry-run is DB-free).
on conflict (key) do nothing;

-- Default rate cards. The rate_key is a trainer COHORT label ("started 2020-2024"
-- vs "2024-onward"), NOT the period a session may be delivered. valid_from/until
-- is when the PRICE is in effect — so both cards are open-ended (they apply to
-- any session date) and would only be closed when that cohort's price changes.
-- €88 for the 2020-2024 cohort, €84 for the 2024-heden cohort.
-- 'variabel' has NO default card by design: variable-rate trainers require a
-- trainer-scoped override, and rate resolution deliberately fails otherwise.
insert into rate_cards (rate_key, trainer_id, valid_from, valid_until, hourly_rate_cents) values
  ('2020-2024', null, '2000-01-01', null, 8800),
  ('2024-heden', null, '2000-01-01', null, 8400);
