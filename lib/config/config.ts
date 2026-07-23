import type { SupabaseClient } from '@supabase/supabase-js';

import { isProductionEnvironment } from '@lib/constants';
import type { Database } from '@lib/types/database';

import { buildAppConfig } from './build';
import type { AppConfig } from './schema';

/**
 * In-memory config cache. Config changes rarely and is small, so a single
 * process-wide cached value is enough. Call {@link clearConfigCache} after a
 * config write (or on a scheduled refresh) to force a reload.
 */
let cache: AppConfig | null = null;

export function clearConfigCache(): void {
  cache = null;
}

/** Load, validate, and cache the application config from the `config` table. */
export async function getAppConfig(supabase: SupabaseClient<Database>): Promise<AppConfig> {
  if (cache) {
    return cache;
  }

  const { data, error } = await supabase.from('config').select('key, value');
  if (error) {
    throw new Error(`Failed to load config: ${error.message}`);
  }

  cache = buildAppConfig(data ?? [], {
    isProduction: isProductionEnvironment,
  });
  return cache;
}
