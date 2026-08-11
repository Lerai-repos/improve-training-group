import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addressKey } from '../address-key';
import { CITY_TTL_MS, createCityStore, createNullCityStore } from '../city-store';
import { createMemoryKvStore } from '../kv';
import { normalizeAddressKey } from '../travel-cache';

import type { KvStore } from '../kv';

const V = 'v2';

/** The key the store uses, recomputed here so the tests can look past it. */
const keyFor = (location: string): string =>
  `city:${V}:${addressKey(normalizeAddressKey(location))}`;

/**
 * The invariant under test is not "the cache works" — it is **the cache cannot hurt**.
 * A city is decoration on a recommendation run; a Redis hiccup while storing one must
 * never reach the run's failure path.
 */
describe('the city store', () => {
  let kv: KvStore;
  beforeEach(() => {
    kv = createMemoryKvStore();
  });

  it('remembers a city against its location', async () => {
    const store = createCityStore(kv);
    await store.remember('Raadhuisplein 1, 5831 JX Boxmeer', V, 'Boxmeer');

    expect(await store.lookup('Raadhuisplein 1, 5831 JX Boxmeer', V)).toBe('Boxmeer');
  });

  it('matches locations that differ only in formatting', async () => {
    const store = createCityStore(kv);
    await store.remember('Raadhuisplein 1, 5831 JX Boxmeer', V, 'Boxmeer');

    expect(await store.lookup('  raadhuisplein 1,  5831 JX  boxmeer ', V)).toBe('Boxmeer');
  });

  /**
   * The reason this is keyed on the address rather than frozen onto a generation: a
   * planner who edits Locatie without recalculating must NOT keep the old town.
   */
  it('misses when the location changed, so the caller falls back to the raw text', async () => {
    const store = createCityStore(kv);
    await store.remember('Raadhuisplein 1, 5831 JX Boxmeer', V, 'Boxmeer');

    expect(await store.lookup('Jaarbeursplein 6A, 3521 AL Utrecht', V)).toBeNull();
  });

  /** A bad model vintage is abandoned by bumping the version, not by hunting keys. */
  it('does not serve a city written under another prompt version', async () => {
    const store = createCityStore(kv);
    await store.remember('Ergens 1', 'v2', 'Boxmeer');

    expect(await store.lookup('Ergens 1', 'v3')).toBeNull();
  });

  it('stores no raw address — the key is a keyed fingerprint', async () => {
    const location = 'Raadhuisplein 1, 5831 JX Boxmeer';
    const store = createCityStore(kv);
    await store.remember(location, V, 'Boxmeer');

    const key = keyFor(location);
    expect(key).not.toContain('Raadhuisplein');
    expect(key).not.toContain('Boxmeer');
    expect(await kv.get(key)).toBe('Boxmeer');
  });

  it('expires the entry', async () => {
    let now = 0;
    const clock = createMemoryKvStore(() => now);
    const store = createCityStore(clock);
    await store.remember('Ergens 1', V, 'Boxmeer');

    now = CITY_TTL_MS + 1;
    expect(await store.lookup('Ergens 1', V)).toBeNull();
  });

  describe('never hurts the run', () => {
    const exploding = (): KvStore =>
      ({
        get: () => Promise.reject(new Error('redis down')),
        set: () => Promise.reject(new Error('redis down')),
      }) as unknown as KvStore;

    it('swallows a failed write', async () => {
      const log = vi.fn();
      const store = createCityStore(exploding(), log);

      await expect(store.remember('Ergens 1', V, 'Boxmeer')).resolves.toBeUndefined();
      expect(log).toHaveBeenCalled();
    });

    it('swallows a failed read and reports no city', async () => {
      const log = vi.fn();
      const store = createCityStore(exploding(), log);

      await expect(store.lookup('Ergens 1', V)).resolves.toBeNull();
      expect(log).toHaveBeenCalled();
    });
  });

  describe('bounds', () => {
    it('refuses to store an absurd city', async () => {
      const store = createCityStore(kv);
      await store.remember('Ergens 1', V, 'x'.repeat(500));

      expect(await store.lookup('Ergens 1', V)).toBeNull();
    });

    it('refuses to store a blank city', async () => {
      const store = createCityStore(kv);
      await store.remember('Ergens 1', V, '   ');

      expect(await store.lookup('Ergens 1', V)).toBeNull();
    });

    /** A value written by a looser earlier version must not reach a message. */
    it('rejects an out-of-bounds value already in the cache', async () => {
      // Written past the store, as an older, unvalidated version would have.
      await kv.set(keyFor('Ergens 1'), 'x'.repeat(500));

      expect(await createCityStore(kv).lookup('Ergens 1', V)).toBeNull();
    });
  });

  it('has a null implementation that succeeds at nothing', async () => {
    const store = createNullCityStore();
    await expect(store.remember('Ergens 1', V, 'Boxmeer')).resolves.toBeUndefined();
    expect(await store.lookup('Ergens 1', V)).toBeNull();
  });
});
