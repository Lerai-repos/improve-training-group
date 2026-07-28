import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { createAdminSupabaseClient } from '@lib/db/admin';
import type { Database } from '@lib/types/database';

/**
 * Client factories for integration tests only. The admin client bypasses RLS;
 * the anon client uses the public anon key (RLS-restricted, role `anon`).
 */

export function adminClient(): SupabaseClient<Database> {
  return createAdminSupabaseClient();
}

export function anonClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL / ANON_KEY for anon client');
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Delete all rows from the domain tables (leaves config + rate_cards baseline). */
export async function truncateDomain(admin: SupabaseClient<Database>): Promise<void> {
  const ANCIENT = '1900-01-01';
  // M2b recommendation rows reference trainings/trainers (ON DELETE RESTRICT) and
  // sync_runs — so they must be cleared FIRST, before the masters below.
  const recommendations = await admin.from('recommendations').delete().gte('created_at', ANCIENT);
  if (recommendations.error) {
    throw new Error(`truncateDomain recommendations: ${recommendations.error.message}`);
  }
  const recRuns = await admin.from('recommendation_runs').delete().gte('created_at', ANCIENT);
  if (recRuns.error) {
    throw new Error(`truncateDomain recommendation_runs: ${recRuns.error.message}`);
  }
  const gen = await admin
    .from('recommendation_generation')
    .delete()
    .neq('training_external_id', '');
  if (gen.error) {
    throw new Error(`truncateDomain recommendation_generation: ${gen.error.message}`);
  }
  const cache = await admin.from('travel_cache').delete().gte('fetched_at', ANCIENT);
  if (cache.error) {
    throw new Error(`truncateDomain travel_cache: ${cache.error.message}`);
  }

  const tables = [
    'training_trainers',
    'training_themas',
    'training_klanten',
    'trainer_theme_qual_observations',
    'trainer_theme_qualifications',
    'trainings',
    'trainers',
    'themas',
    'klanten',
  ] as const;

  for (const table of tables) {
    const { error } = await admin.from(table).delete().gte('created_at', ANCIENT);
    if (error) {
      throw new Error(`truncateDomain ${table}: ${error.message}`);
    }
  }

  const runs = await admin.from('sync_runs').delete().gte('started_at', ANCIENT);
  if (runs.error) {
    throw new Error(`truncateDomain sync_runs: ${runs.error.message}`);
  }
}
