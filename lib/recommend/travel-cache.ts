import { addressKey } from './address-key';

import type { TravelCache } from './travel-resolve';

/**
 * Travel result cache. Positive results (ROUTE_EXISTS) are long-lived; terminal
 * negatives (ROUTE_NOT_FOUND) get a SHORT TTL so a fixed address is retried before
 * long. Transient failures are NEVER written here (the caller enforces that).
 * Entries store ONE-WAY km/min; the round-trip doubling happens in enrichment.
 *
 * The backing store is abstracted so the KV implementation can drop in next pass.
 * What must NOT change with it: the key is a KEYED HMAC fingerprint of the
 * normalized address (`address-key.ts`), never the raw string — a Monday board or
 * a shared cache holding client addresses in the clear would be a step backwards.
 */

/** ROUTE_NOT_FOUND rows are re-checked after this long. */
export const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

export interface CachedLeg {
  condition: string; // 'ROUTE_EXISTS' | 'ROUTE_NOT_FOUND'
  distanceKm: number | null;
  durationMinutes: number | null;
}

interface StoredLeg extends CachedLeg {
  fetchedAtMs: number;
}

/** Minimal key/value contract — satisfied in-process today, by KV next pass. */
export interface TravelCacheStore {
  get(key: string): Promise<StoredLeg | null>;
  set(key: string, value: StoredLeg): Promise<void>;
}

/** Normalize an address into a stable cache key component. */
export function normalizeAddressKey(address: string): string {
  return address.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Composite entry key: fingerprints only, so no raw address is ever stored. */
export function travelCacheKey(
  originNorm: string,
  destinationNorm: string,
  routingKey: string
): string {
  return `${addressKey(originNorm)}:${addressKey(destinationNorm)}:${routingKey}`;
}

export function createMemoryTravelCacheStore(): TravelCacheStore {
  const map = new Map<string, StoredLeg>();
  return {
    get: (key) => Promise.resolve(map.get(key) ?? null),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

/**
 * A {@link TravelCache} over any store. `now` is injectable so the negative-TTL
 * boundary is testable without waiting a day.
 */
export function createTravelCache(
  store: TravelCacheStore,
  now: () => number = Date.now
): TravelCache {
  return {
    async lookup(originNorm, destinationNorm, routingKey) {
      const entry = await store.get(travelCacheKey(originNorm, destinationNorm, routingKey));
      if (!entry) {
        return null;
      }
      // A stale terminal negative is reported as a MISS so the address is retried.
      if (entry.condition === 'ROUTE_NOT_FOUND' && now() - entry.fetchedAtMs > NEGATIVE_TTL_MS) {
        return null;
      }
      return {
        condition: entry.condition,
        distanceKm: entry.distanceKm,
        durationMinutes: entry.durationMinutes,
      };
    },
    async write(row) {
      await store.set(travelCacheKey(row.originNorm, row.destinationNorm, row.routingKey), {
        condition: row.condition,
        distanceKm: row.distanceKm,
        durationMinutes: row.durationMinutes,
        fetchedAtMs: now(),
      });
    },
  };
}
