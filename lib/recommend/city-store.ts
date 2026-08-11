import { z } from 'zod';

import { CITY_MAX_LENGTH } from './address';
import { addressKey } from './address-key';
import { normalizeAddressKey } from './travel-cache';

import type { KvStore } from './kv';

/**
 * The town a training's location is in, cached against the ADDRESS rather than against
 * the training.
 *
 * This is the whole reason the WhatsApp message can say "Boxmeer" without ever going
 * stale. Freezing the city onto a generation's artifact was the obvious design and it is
 * wrong: change `Locatie` in Monday without recalculating and the artifact still holds
 * the old town, the generated message does not move, and the staleness guard therefore
 * never fires. Keyed on the address, a changed location is a changed key, the lookup
 * misses, and the message falls back to the live raw text. Staleness is impossible rather
 * than guarded against.
 *
 * The key is the same keyed HMAC fingerprint the travel cache uses, so **no raw address
 * is persisted** — consistent with the rule that Redis holds ids and numbers.
 */

/** Six months. Long enough that venues stay warm, short enough to shed a bad vintage. */
export const CITY_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * The prompt version is IN the key. A model revision that starts returning nonsense is
 * abandoned wholesale by bumping it, rather than by hunting down individual keys — and
 * v1's cities, which never existed, cannot be mistaken for v2's.
 */
const cityKey = (rawLocation: string, promptVersion: string): string =>
  `city:${promptVersion}:${addressKey(normalizeAddressKey(rawLocation))}`;

const citySchema = z.string().trim().min(1).max(CITY_MAX_LENGTH);

export interface CityStore {
  /** The cached town for this raw location, or null. Never throws. */
  lookup(rawLocation: string, promptVersion: string): Promise<string | null>;
  /** Remember a town. Best-effort: never throws, never delays a caller's outcome. */
  remember(rawLocation: string, promptVersion: string, city: string): Promise<void>;
}

/**
 * Both methods swallow their own failures, and that is the contract rather than
 * laziness.
 *
 * `remember` is called from `service.ts` after a successful classification. If it threw,
 * a Redis hiccup would land on the recommendation failure path and turn a completed run
 * into a retryable FOUT — a cache write costing us an answer, which is precisely the
 * inversion this port exists to prevent. `lookup` swallows for the same reason on the
 * read side: no city simply means the message prints the raw location.
 */
export function createCityStore(kv: KvStore, log: (message: string, error: unknown) => void = defaultLog): CityStore {
  return {
    async lookup(rawLocation: string, promptVersion: string): Promise<string | null> {
      try {
        const raw = await kv.get(cityKey(rawLocation, promptVersion));
        if (raw === null) {
          return null;
        }
        // Validated on the way out too: a value written by an older, looser version must
        // not reach a message just because it is in the cache.
        const parsed = citySchema.safeParse(raw);
        return parsed.success ? parsed.data : null;
      } catch (error) {
        log('cityStore.lookup failed', error);
        return null;
      }
    },

    async remember(rawLocation: string, promptVersion: string, city: string): Promise<void> {
      const parsed = citySchema.safeParse(city);
      if (!parsed.success) {
        return;
      }
      try {
        await kv.set(cityKey(rawLocation, promptVersion), parsed.data, { ttlMs: CITY_TTL_MS });
      } catch (error) {
        log('cityStore.remember failed', error);
      }
    },
  };
}

function defaultLog(message: string, error: unknown): void {
  console.error(message, error instanceof Error ? error.message : String(error));
}

/** Does nothing, successfully — for runs with no key/value store wired. */
export function createNullCityStore(): CityStore {
  return {
    lookup: () => Promise.resolve(null),
    remember: () => Promise.resolve(),
  };
}
