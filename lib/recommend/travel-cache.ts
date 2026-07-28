import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@lib/types/database';

import { addressKey } from './address-key';

/**
 * Travel result cache. Positive results (ROUTE_EXISTS) are long-lived; terminal
 * negatives (ROUTE_NOT_FOUND) get a SHORT TTL so a fixed address is retried before
 * long. Transient failures are NEVER written here (the caller enforces that). Rows
 * store ONE-WAY km/min; the round-trip doubling happens later in enrichment.
 */

type Admin = SupabaseClient<Database>;

/** ROUTE_NOT_FOUND rows are re-checked after this long. */
export const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

export interface CachedLeg {
  condition: string; // 'ROUTE_EXISTS' | 'ROUTE_NOT_FOUND'
  distanceKm: number | null;
  durationMinutes: number | null;
}

/** Normalize an address into a stable cache key component. */
export function normalizeAddressKey(address: string): string {
  return address.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Look up a cached one-way leg. A positive row is returned regardless of age; a
 * negative (ROUTE_NOT_FOUND) row past {@link NEGATIVE_TTL_MS} is treated as a MISS
 * so it gets re-fetched. `now` is injectable for deterministic tests.
 */
export async function lookupTravel(
  admin: Admin,
  originNorm: string,
  destinationNorm: string,
  routingKey: string,
  now: number = Date.now()
): Promise<CachedLeg | null> {
  // Store only the KEYED hash of the normalized address, never the raw string (PII).
  const { data, error } = await admin
    .from('travel_cache')
    .select('condition, distance_km, duration_minutes, fetched_at')
    .eq('origin_key', addressKey(originNorm))
    .eq('destination_key', addressKey(destinationNorm))
    .eq('routing_key', routingKey)
    .maybeSingle();
  if (error) {
    throw new Error(`travel_cache lookup: ${error.message}`);
  }
  if (!data) {
    return null;
  }
  if (data.condition === 'ROUTE_NOT_FOUND') {
    const age = now - new Date(data.fetched_at).getTime();
    if (age > NEGATIVE_TTL_MS) {
      return null;
    }
  }
  return {
    condition: data.condition,
    distanceKm: data.distance_km,
    durationMinutes: data.duration_minutes,
  };
}

/** Upsert a cache row (positive or terminal-negative only). Refreshes `fetched_at`. */
export async function writeTravel(
  admin: Admin,
  row: {
    originNorm: string;
    destinationNorm: string;
    routingKey: string;
    condition: string;
    distanceKm: number | null;
    durationMinutes: number | null;
  }
): Promise<void> {
  const { error } = await admin.from('travel_cache').upsert(
    {
      origin_key: addressKey(row.originNorm),
      destination_key: addressKey(row.destinationNorm),
      routing_key: row.routingKey,
      condition: row.condition,
      distance_km: row.distanceKm,
      duration_minutes: row.durationMinutes,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: 'origin_key,destination_key,routing_key' }
  );
  if (error) {
    throw new Error(`travel_cache write: ${error.message}`);
  }
}
