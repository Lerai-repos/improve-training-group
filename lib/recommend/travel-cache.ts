import { z } from 'zod';

import { addressKey } from './address-key';

import type { KvStore } from './kv';
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

/**
 * Minimal key/value contract — satisfied in-process and by Redis.
 *
 * `ttlMs` lets a shared store expire the entry itself. The `fetchedAtMs` check below
 * still stands on its own: an in-process store has no expiry mechanism, and a stored
 * entry must never be trusted past its negative TTL just because the backend happened
 * not to evict it.
 */
export interface TravelCacheStore {
  get(key: string): Promise<StoredLeg | null>;
  set(key: string, value: StoredLeg, opts?: { ttlMs?: number }): Promise<void>;
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

/**
 * Semantic, not merely structural. Only the two conditions this system writes are
 * accepted, each with the metric shape that belongs to it.
 *
 * The looser version was a trap. `cachedToElement` maps an unrecognised condition to
 * `transient` — correct for a live provider reply, wrong for a stored row, because
 * transient means retryable and the retry reads the same bad row. Positive entries
 * carry no TTL, so it would never self-heal, and the HQ leg is shared: one bad row
 * would fail every training at that destination until someone cleared Redis by hand.
 *
 * Rejecting it makes it a MISS, so the next provider call overwrites it.
 */
const storedLegSchema = z.union([
  z.object({
    condition: z.literal('ROUTE_EXISTS'),
    distanceKm: z.number().finite().nonnegative(),
    durationMinutes: z.number().finite().nonnegative(),
    fetchedAtMs: z.number().finite(),
  }),
  z.object({
    condition: z.literal('ROUTE_NOT_FOUND'),
    // Metrics must be absent for a negative: a "not found" carrying a distance is a
    // contradiction, and trusting either half of it would be a guess.
    distanceKm: z.null(),
    durationMinutes: z.null(),
    fetchedAtMs: z.number().finite(),
  }),
]);

/** Unreadable → null (a miss). Never throws: see the note in `get` below. */
function parseStoredLeg(raw: string): StoredLeg | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = storedLegSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * Shared store over {@link KvStore}. Safe to share because the key is a KEYED HMAC
 * fingerprint of the normalized address (`address-key.ts`) and the value carries only
 * distance/duration — no raw address ever leaves this process.
 *
 * A malformed entry is treated as a MISS rather than trusted: the fail-closed rule
 * here is that a corrupt cache row must cost a provider call, never become free
 * travel.
 */
export function createKvTravelCacheStore(kv: KvStore): TravelCacheStore {
  return {
    async get(key) {
      const raw = await kv.get(`travel:${key}`);
      if (raw === null) {
        return null;
      }
      // `JSON.parse` THROWS, and a throw here is not a cache miss — it escapes through
      // `resolveTravel` into the run's error path, so one corrupt or stale-format entry
      // would fail the same training on every retry until it dead-lettered as FOUT.
      // A cache is an optimisation: an unreadable entry must cost a provider call.
      return parseStoredLeg(raw);
    },
    async set(key, value, opts) {
      await kv.set(`travel:${key}`, JSON.stringify(value), opts);
    },
  };
}

export function createMemoryTravelCacheStore(): TravelCacheStore {
  const map = new Map<string, StoredLeg>();
  return {
    get: (key) => Promise.resolve(map.get(key) ?? null),
    // TTL is ignored: nothing evicts in-process, and `fetchedAtMs` already bounds a
    // negative entry's usefulness independently of the backend.
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
      await store.set(
        travelCacheKey(row.originNorm, row.destinationNorm, row.routingKey),
        {
          condition: row.condition,
          distanceKm: row.distanceKm,
          durationMinutes: row.durationMinutes,
          fetchedAtMs: now(),
        },
        // Terminal negatives are re-checked after a day; positives are long-lived, so
        // a shared store keeps them until it needs the space.
        row.condition === 'ROUTE_NOT_FOUND' ? { ttlMs: NEGATIVE_TTL_MS } : undefined
      );
    },
  };
}
