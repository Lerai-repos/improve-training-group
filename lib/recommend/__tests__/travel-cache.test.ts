import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '../kv';
import {
  createKvTravelCacheStore,
  createMemoryTravelCacheStore,
  createTravelCache,
  NEGATIVE_TTL_MS,
  normalizeAddressKey,
} from '../travel-cache';

describe('normalizeAddressKey', () => {
  it('lowercases, collapses whitespace, trims, NFC-normalizes', () => {
    expect(normalizeAddressKey('  Wolvenplein   25,  Utrecht ')).toBe('wolvenplein 25, utrecht');
    expect(normalizeAddressKey('CAFÉ\tX')).toBe('café x');
  });

  it('equal addresses that differ only in spacing/case map to the same key', () => {
    expect(normalizeAddressKey('Raadhuisplein 1')).toBe(normalizeAddressKey('raadhuisplein  1'));
  });
});

/**
 * Converted from the deleted `travel-cache.integration.test.ts`. The cache is being
 * reimplemented (Postgres table → key/value store), so this coverage matters more,
 * not less. The clock is injected so the negative-TTL boundary is testable without
 * waiting a day.
 */
/**
 * A cache is an optimisation, so an entry it cannot read must cost a provider call —
 * never a run failure. Letting `JSON.parse` throw here would escape through
 * `resolveTravel` into the run's error path, failing the same training on every retry
 * until it dead-lettered as FOUT.
 */
describe('createKvTravelCacheStore', () => {
  const KEY = 'origin:dest:routing';

  it('reports corrupt JSON as a miss rather than throwing', async () => {
    const kv = createMemoryKvStore();
    await kv.set(`travel:${KEY}`, '{not json');
    await expect(createKvTravelCacheStore(kv).get(KEY)).resolves.toBeNull();
  });

  it('reports a well-formed but wrong-shaped entry as a miss', async () => {
    const kv = createMemoryKvStore();
    await kv.set(`travel:${KEY}`, JSON.stringify({ condition: 'ROUTE_EXISTS' }));
    await expect(createKvTravelCacheStore(kv).get(KEY)).resolves.toBeNull();
  });

  /**
   * Semantic validation, not just shape. `cachedToElement` maps an unrecognised
   * condition to `transient`, which is right for a live provider reply and a trap for a
   * CACHED row: transient ⇒ retryable ⇒ the retry reads the same bad row and fails
   * again. Positive entries carry no TTL, so it would never self-heal — and since the
   * HQ leg is shared, one bad row would break every training at that destination.
   * Rejecting it here makes it a miss, so the provider call overwrites it.
   */
  const rejected: Array<[string, unknown]> = [
    ['an unrecognised condition', { condition: 'old-format', distanceKm: 1, durationMinutes: 1, fetchedAtMs: 1 }],
    ['ROUTE_EXISTS with null metrics', { condition: 'ROUTE_EXISTS', distanceKm: null, durationMinutes: null, fetchedAtMs: 1 }],
    ['ROUTE_EXISTS with a negative distance', { condition: 'ROUTE_EXISTS', distanceKm: -5, durationMinutes: 1, fetchedAtMs: 1 }],
    ['ROUTE_NOT_FOUND carrying metrics', { condition: 'ROUTE_NOT_FOUND', distanceKm: 10, durationMinutes: 5, fetchedAtMs: 1 }],
  ];

  it.each(rejected)('treats %s as a miss', async (_label, entry) => {
    const kv = createMemoryKvStore();
    await kv.set(`travel:${KEY}`, JSON.stringify(entry));
    await expect(createKvTravelCacheStore(kv).get(KEY)).resolves.toBeNull();
  });

  it('accepts a valid ROUTE_NOT_FOUND', async () => {
    const kv = createMemoryKvStore();
    const entry = {
      condition: 'ROUTE_NOT_FOUND',
      distanceKm: null,
      durationMinutes: null,
      fetchedAtMs: 7,
    };
    await kv.set(`travel:${KEY}`, JSON.stringify(entry));
    await expect(createKvTravelCacheStore(kv).get(KEY)).resolves.toEqual(entry);
  });

  it('round-trips a valid entry', async () => {
    const kv = createMemoryKvStore();
    const store = createKvTravelCacheStore(kv);
    await store.set(KEY, {
      condition: 'ROUTE_EXISTS',
      distanceKm: 10,
      durationMinutes: 20,
      fetchedAtMs: 5,
    });
    await expect(store.get(KEY)).resolves.toEqual({
      condition: 'ROUTE_EXISTS',
      distanceKm: 10,
      durationMinutes: 20,
      fetchedAtMs: 5,
    });
  });
});

describe('createTravelCache', () => {
  const ROUTING = 'google-routes:DRIVE:TRAFFIC_UNAWARE:v1';
  const positive = {
    originNorm: 'a straat 1',
    destinationNorm: 'b laan 2',
    routingKey: ROUTING,
    condition: 'ROUTE_EXISTS',
    distanceKm: 10,
    durationMinutes: 20,
  };

  it('returns a stored positive entry', async () => {
    const cache = createTravelCache(createMemoryTravelCacheStore());
    await cache.write(positive);
    expect(await cache.lookup('a straat 1', 'b laan 2', ROUTING)).toEqual({
      condition: 'ROUTE_EXISTS',
      distanceKm: 10,
      durationMinutes: 20,
    });
  });

  it('misses on a different routing key (isolation)', async () => {
    const cache = createTravelCache(createMemoryTravelCacheStore());
    await cache.write(positive);
    expect(await cache.lookup('a straat 1', 'b laan 2', 'other:v2')).toBeNull();
  });

  it('overwrites an entry in place', async () => {
    const cache = createTravelCache(createMemoryTravelCacheStore());
    await cache.write(positive);
    await cache.write({ ...positive, distanceKm: 99, durationMinutes: 88 });
    expect(await cache.lookup('a straat 1', 'b laan 2', ROUTING)).toMatchObject({
      distanceKm: 99,
      durationMinutes: 88,
    });
  });

  it('keeps a positive entry indefinitely, but expires a negative one', async () => {
    let now = 1_000_000;
    const cache = createTravelCache(createMemoryTravelCacheStore(), () => now);
    await cache.write(positive);
    await cache.write({
      ...positive,
      originNorm: 'c weg 3',
      condition: 'ROUTE_NOT_FOUND',
      distanceKm: null,
      durationMinutes: null,
    });

    now += NEGATIVE_TTL_MS + 1;
    // The positive survives; the terminal negative is reported as a MISS so the
    // address is retried rather than being excluded forever.
    expect(await cache.lookup('a straat 1', 'b laan 2', ROUTING)).not.toBeNull();
    expect(await cache.lookup('c weg 3', 'b laan 2', ROUTING)).toBeNull();
  });

  it('still returns a negative entry that is exactly at the TTL boundary', async () => {
    let now = 1_000_000;
    const cache = createTravelCache(createMemoryTravelCacheStore(), () => now);
    await cache.write({
      ...positive,
      condition: 'ROUTE_NOT_FOUND',
      distanceKm: null,
      durationMinutes: null,
    });
    now += NEGATIVE_TTL_MS; // boundary is >, not >=
    expect(await cache.lookup('a straat 1', 'b laan 2', ROUTING)).not.toBeNull();
  });
});
