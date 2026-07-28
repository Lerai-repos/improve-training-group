import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@lib/types/database';

import { addressKey } from './address-key';
import type { ArtifactRoute } from './artifact';
import type { RouteElement, TravelProvider } from './travel';
import { lookupTravel, normalizeAddressKey, writeTravel, type CachedLeg } from './travel-cache';
import { toTrainerTravel } from './travel-enrich';
import type { CandidateTrainer, TrainerTravel } from './types';

/**
 * Origin-aware travel resolution. The HQ leg + each trainer leg are cache-first
 * (misses batched to the Routes provider). Classification is deliberately not
 * symmetric with €0:
 *   - shared HQ/destination failing (transient OR terminal) → the run is FOUT
 *     (it invalidates every comparison — never exclude-everyone into GEEN MATCH);
 *   - a per-trainer ROUTE_NOT_FOUND → exclude THAT trainer (cache short-negative);
 *   - any transient trainer failure → FOUT (retry), never cached, never €0;
 *   - a trainer with no address → excluded (`no_address`), not €0.
 * Only positive (ROUTE_EXISTS) results are cached long-lived.
 */

/** Minimal cache surface (a Supabase impl + an in-memory test impl satisfy it). */
export interface TravelCache {
  lookup(
    originNorm: string,
    destinationNorm: string,
    routingKey: string
  ): Promise<CachedLeg | null>;
  write(row: {
    originNorm: string;
    destinationNorm: string;
    routingKey: string;
    condition: string;
    distanceKm: number | null;
    durationMinutes: number | null;
  }): Promise<void>;
}

export type TravelResolution =
  | {
      kind: 'ok';
      byTrainer: Map<string, TrainerTravel>;
      excluded: Array<{ externalItemId: string; reason: string }>;
      routes: ArtifactRoute[];
      /** How many legs (HQ + trainers) were served from the cache (provenance/audit). */
      cacheHits: number;
    }
  | { kind: 'fout'; detail: string };

/** Keyed (HMAC, non-dictionary-recoverable) fingerprint of an address for the audit artifact. */
export function addressFingerprint(norm: string): string {
  return addressKey(norm);
}

function routeRecord(
  originNorm: string,
  destinationNorm: string,
  routingKey: string,
  condition: string,
  distanceKm: number | null,
  durationMinutes: number | null
): ArtifactRoute {
  return {
    originFingerprint: addressFingerprint(originNorm),
    destinationFingerprint: addressFingerprint(destinationNorm),
    routingKey,
    condition,
    oneWayDistanceKm: distanceKm,
    oneWayDurationMinutes: durationMinutes,
  };
}

function isFiniteNonNegative(n: number | null): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function cachedToElement(hit: CachedLeg): RouteElement {
  if (hit.condition === 'ROUTE_NOT_FOUND') {
    return { status: 'not_found' };
  }
  // Only a well-formed positive row becomes a priced leg. A malformed row (unknown
  // condition, or missing/negative metrics) must NOT silently become free travel →
  // classify transient (fail-closed), never a zeroed success.
  if (
    hit.condition === 'ROUTE_EXISTS' &&
    isFiniteNonNegative(hit.distanceKm) &&
    isFiniteNonNegative(hit.durationMinutes)
  ) {
    return {
      status: 'ok',
      leg: { distanceKm: hit.distanceKm, durationMinutes: hit.durationMinutes },
    };
  }
  return { status: 'transient', detail: `malformed travel_cache row (condition=${hit.condition})` };
}

async function cacheElement(
  cache: TravelCache,
  originNorm: string,
  destinationNorm: string,
  routingKey: string,
  el: RouteElement
): Promise<void> {
  // Only positive + terminal-negative are cached; transient is never persisted.
  if (el.status === 'ok') {
    await cache.write({
      originNorm,
      destinationNorm,
      routingKey,
      condition: 'ROUTE_EXISTS',
      distanceKm: el.leg.distanceKm,
      durationMinutes: el.leg.durationMinutes,
    });
  } else if (el.status === 'not_found') {
    await cache.write({
      originNorm,
      destinationNorm,
      routingKey,
      condition: 'ROUTE_NOT_FOUND',
      distanceKm: null,
      durationMinutes: null,
    });
  }
}

export async function resolveTravel(
  cache: TravelCache,
  provider: TravelProvider,
  input: { destination: string; hqAddress: string; trainers: readonly CandidateTrainer[] }
): Promise<TravelResolution> {
  const routingKey = provider.routingKey();
  const destinationNorm = normalizeAddressKey(input.destination);
  const routes: ArtifactRoute[] = [];
  let cacheHits = 0;

  // --- HQ leg (shared; any failure fails the whole run) ---
  const hqNorm = normalizeAddressKey(input.hqAddress);
  const hqHit = await cache.lookup(hqNorm, destinationNorm, routingKey);
  let hqElement: RouteElement;
  if (hqHit) {
    cacheHits += 1;
    hqElement = cachedToElement(hqHit);
    routes.push(
      routeRecord(
        hqNorm,
        destinationNorm,
        routingKey,
        hqHit.condition,
        hqHit.distanceKm,
        hqHit.durationMinutes
      )
    );
  } else {
    const [el] = await provider.distances([input.hqAddress], input.destination);
    hqElement = el;
    await cacheElement(cache, hqNorm, destinationNorm, routingKey, el);
    routes.push(routeFromElement(hqNorm, destinationNorm, routingKey, el));
  }
  if (hqElement.status === 'transient') {
    return { kind: 'fout', detail: `HQ route transient: ${hqElement.detail}` };
  }
  if (hqElement.status === 'not_found') {
    return { kind: 'fout', detail: 'destination unreachable (HQ route not found)' };
  }
  const hqLeg = hqElement.leg;

  // --- Trainer legs ---
  const excluded: Array<{ externalItemId: string; reason: string }> = [];
  const withAddress: Array<{ trainer: CandidateTrainer; address: string; norm: string }> = [];
  for (const t of input.trainers) {
    const address = (t.adres ?? '').trim();
    if (address === '') {
      excluded.push({ externalItemId: t.externalItemId, reason: 'no_address' });
      continue;
    }
    withAddress.push({ trainer: t, address, norm: normalizeAddressKey(address) });
  }

  const elementByTrainer = new Map<string, RouteElement>();
  const misses: Array<{ externalItemId: string; address: string; norm: string }> = [];
  for (const w of withAddress) {
    const hit = await cache.lookup(w.norm, destinationNorm, routingKey);
    if (hit) {
      cacheHits += 1;
      elementByTrainer.set(w.trainer.externalItemId, cachedToElement(hit));
      routes.push(
        routeRecord(
          w.norm,
          destinationNorm,
          routingKey,
          hit.condition,
          hit.distanceKm,
          hit.durationMinutes
        )
      );
    } else {
      misses.push({ externalItemId: w.trainer.externalItemId, address: w.address, norm: w.norm });
    }
  }
  if (misses.length > 0) {
    const elements = await provider.distances(
      misses.map((m) => m.address),
      input.destination
    );
    for (let i = 0; i < misses.length; i += 1) {
      const el = elements[i] ?? { status: 'transient', detail: 'missing element' };
      elementByTrainer.set(misses[i].externalItemId, el);
      await cacheElement(cache, misses[i].norm, destinationNorm, routingKey, el);
      routes.push(routeFromElement(misses[i].norm, destinationNorm, routingKey, el));
    }
  }

  const byTrainer = new Map<string, TrainerTravel>();
  for (const w of withAddress) {
    const el = elementByTrainer.get(w.trainer.externalItemId);
    if (!el || el.status === 'transient') {
      // A transient trainer failure poisons the run — never €0, never partial.
      return { kind: 'fout', detail: `trainer route transient (${w.trainer.externalItemId})` };
    }
    if (el.status === 'not_found') {
      excluded.push({ externalItemId: w.trainer.externalItemId, reason: 'route_not_found' });
      continue;
    }
    byTrainer.set(w.trainer.externalItemId, toTrainerTravel(el.leg, hqLeg));
  }

  return { kind: 'ok', byTrainer, excluded, routes, cacheHits };
}

function routeFromElement(
  originNorm: string,
  destinationNorm: string,
  routingKey: string,
  el: RouteElement
): ArtifactRoute {
  if (el.status === 'ok') {
    return routeRecord(
      originNorm,
      destinationNorm,
      routingKey,
      'ROUTE_EXISTS',
      el.leg.distanceKm,
      el.leg.durationMinutes
    );
  }
  if (el.status === 'not_found') {
    return routeRecord(originNorm, destinationNorm, routingKey, 'ROUTE_NOT_FOUND', null, null);
  }
  return routeRecord(originNorm, destinationNorm, routingKey, 'TRANSIENT', null, null);
}

/** Supabase-backed cache adapter (wraps the travel_cache lookup/write helpers). */
export function createSupabaseTravelCache(admin: SupabaseClient<Database>): TravelCache {
  return {
    lookup: (originNorm, destinationNorm, routingKey) =>
      lookupTravel(admin, originNorm, destinationNorm, routingKey),
    write: (row) => writeTravel(admin, row),
  };
}
