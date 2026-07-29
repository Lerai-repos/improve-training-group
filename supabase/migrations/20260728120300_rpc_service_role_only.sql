-- The recommendation RPCs all documented themselves as "service_role-only" and did
-- `revoke all ... from public`. That is NOT sufficient on Supabase: `anon` and
-- `authenticated` hold EXECUTE via explicit default privileges, not via PUBLIC, so
-- revoking PUBLIC left them able to call these functions (verified in pg_proc.proacl).
--
-- No data ever leaked — every one of them is `security invoker` and every underlying
-- table is RLS deny-all, so an anon call returns nothing. But the grant should match
-- the stated intent, so revoke explicitly from both roles.

revoke all on function public.enqueue_recommendation_run(text, text, text) from anon, authenticated;
revoke all on function public.claim_recommendation_run(text, integer) from anon, authenticated;
revoke all on function public.claim_recommendation_run_by_id(uuid, text, integer) from anon, authenticated;
revoke all on function public.read_recommendation_inputs(text[]) from anon, authenticated;
revoke all on function public.eligible_trainers_for_training(uuid, text[]) from anon, authenticated;
revoke all on function public.apply_recommendations(uuid, uuid, integer, jsonb) from anon, authenticated;
revoke all on function public.acquire_delivery_lease(uuid, text, integer) from anon, authenticated;
revoke all on function public.finalize_delivery(uuid, text, boolean, text) from anon, authenticated;
revoke all on function public.trainer_group_readiness(date) from anon, authenticated;

-- The M2a sync RPCs have the same insufficient revoke. `apply_monday_snapshot` is the
-- full snapshot-overwrite entry point, so leaving it callable with the public anon key
-- (blocked only by RLS, not by the grant) is exactly the posture this migration exists
-- to correct.
revoke all on function public.apply_monday_snapshot(uuid, jsonb) from anon, authenticated;
revoke all on function public.jsonb_content_md5(jsonb) from anon, authenticated;
