import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@lib/types/database';

/**
 * Service-role Supabase client — bypasses RLS.
 *
 * For server-side scripts and privileged jobs ONLY (seed, migration tooling,
 * sync/reconcile). Never import this into a React component, a route handler
 * that serves untrusted input, or anything reachable by the browser. Request-
 * scoped reads use `createServerSupabaseClient()` from `@lib/db` instead.
 *
 * The service-role key must come from a server-only secret (Doppler / .env.local),
 * never a `NEXT_PUBLIC_` var. The browser guard below hard-fails if this ever
 * reaches client code; `server-only` is deliberately NOT used here because it
 * throws under tsx/Vitest, and this client must be usable from scripts + tests.
 */
export function createAdminSupabaseClient(): SupabaseClient<Database> {
  if (typeof window !== 'undefined') {
    throw new Error('The admin Supabase client must never run in the browser');
  }

  // Read env at call time, not module load — scripts load .env.local dynamically
  // and `import` hoisting would otherwise capture undefined.
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY for the admin client');
  }

  return createClient<Database>(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
