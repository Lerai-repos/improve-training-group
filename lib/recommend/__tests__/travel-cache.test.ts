import { describe, expect, it } from 'vitest';

import {
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
