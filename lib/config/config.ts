import type { SupabaseClient } from '@supabase/supabase-js';

import { isProductionEnvironment } from '@lib/constants';
import type { Database } from '@lib/types/database';

import { buildAppConfig } from './build';
import type { AppConfig } from './schema';

/**
 * In-memory config cache with a short TTL. The config is small and changes rarely,
 * but it is now EDITABLE (recommendable trainer groups), so an unbounded cache
 * would let warm serverless instances disagree with each other indefinitely — a
 * config change would appear to do nothing on some instances. The TTL bounds that
 * divergence to {@link CONFIG_TTL_MS}. {@link clearConfigCache} forces a reload.
 */
export const CONFIG_TTL_MS = 60_000;

let cache: AppConfig | null = null;
let cachedAtMs = 0;

/** Injectable clock so tests can advance time instead of waiting a real minute. */
let now: () => number = Date.now;

export function clearConfigCache(): void {
  cache = null;
  cachedAtMs = 0;
}

/** Test seam: override the clock used for TTL expiry (pass nothing to restore). */
export function setConfigClock(clock: () => number = Date.now): void {
  now = clock;
}

/** Load, validate, and cache the application config from the `config` table. */
export async function getAppConfig(supabase: SupabaseClient<Database>): Promise<AppConfig> {
  if (cache && now() - cachedAtMs < CONFIG_TTL_MS) {
    return cache;
  }

  const { data, error } = await supabase.from('config').select('key, value');
  if (error) {
    throw new Error(`Failed to load config: ${error.message}`);
  }

  cache = buildAppConfig(data ?? [], {
    isProduction: isProductionEnvironment,
  });
  cachedAtMs = now();
  return cache;
}
