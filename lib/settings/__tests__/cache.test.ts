import { describe, expect, it, vi } from 'vitest';

import { createMemoryKvStore } from '@lib/recommend/kv';

import { createCachedSettings, SETTINGS_TTL_MS } from '../cache';

import type { SettingsSnapshot } from '../snapshot';

const noSleep = (): Promise<void> => Promise.resolve();

const snapshot = (boardId: string, fingerprint = 'abc123'): SettingsSnapshot => ({
  app: {
    hqAddress: 'Wolvenplein 25, Utrecht',
    evaluationThresholdHours: 4,
    travelRateTrainerCentsPerKm: 23,
    travelRateClientCentsPerKm: 45,
    travelTimeThresholdMinutes: 90,
    travelTimeMode: 'per_minute',
    travelTimeFeePerMinuteCents: 100,
    recommendableTrainerGroups: ['topics'],
  },
  rateCards: [
    {
      rateKey: '2020-2024',
      trainerId: null,
      validFrom: '2000-01-01',
      validUntil: null,
      hourlyRateCents: 8800,
    },
  ],
  boardId,
  readAt: 1_760_000_000_000,
  fingerprint,
});

describe('createCachedSettings', () => {
  it('reads once and serves the rest from cache', async () => {
    const kv = createMemoryKvStore();
    const load = vi.fn(() => Promise.resolve(snapshot('123')));
    const cache = createCachedSettings({ kv, boardId: '123', load, env: {}, sleep: noSleep });

    expect((await cache.read()).app.travelRateTrainerCentsPerKm).toBe(23);
    expect((await cache.read()).app.travelRateTrainerCentsPerKm).toBe(23);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('round-trips the snapshot through Redis without losing anything', async () => {
    const kv = createMemoryKvStore();
    const original = snapshot('123', 'fingerprint-xyz');
    const cache = createCachedSettings({
      kv,
      boardId: '123',
      load: () => Promise.resolve(original),
      env: {},
      sleep: noSleep,
    });

    await cache.read();
    // Second read comes from the encoded entry, not the loader.
    expect(await cache.read()).toEqual(original);
  });

  /**
   * Preview and production share one Redis, and the destructive verification steps
   * deliberately point a preview at an isolated board with `abc` in a travel rate.
   * Without the deployment and board in the key, that would be served to production.
   */
  it('does not share an entry between two settings boards', async () => {
    const kv = createMemoryKvStore();
    const production = createCachedSettings({
      kv,
      boardId: 'prod',
      load: () => Promise.resolve(snapshot('prod', 'real')),
      env: { VERCEL_ENV: 'production' },
      sleep: noSleep,
    });
    const preview = createCachedSettings({
      kv,
      boardId: 'preview',
      load: () => Promise.resolve(snapshot('preview', 'broken')),
      env: { VERCEL_ENV: 'preview' },
      sleep: noSleep,
    });

    expect((await preview.read()).fingerprint).toBe('broken');
    expect((await production.read()).fingerprint).toBe('real');
  });

  it('does not share an entry between deployments on the same board', async () => {
    const kv = createMemoryKvStore();
    const same = { kv, boardId: 'same', sleep: noSleep };
    const production = createCachedSettings({
      ...same,
      load: () => Promise.resolve(snapshot('same', 'real')),
      env: { VERCEL_ENV: 'production' },
    });
    const preview = createCachedSettings({
      ...same,
      load: () => Promise.resolve(snapshot('same', 'broken')),
      env: { VERCEL_ENV: 'preview' },
    });

    expect((await preview.read()).fingerprint).toBe('broken');
    expect((await production.read()).fingerprint).toBe('real');
  });

  /**
   * A failed settings read must never be cached as an empty or default config — that
   * would be a plausible-looking answer, which is the one thing worse than an error.
   */
  it('propagates a failure rather than caching a default', async () => {
    const kv = createMemoryKvStore();
    const cache = createCachedSettings({
      kv,
      boardId: '123',
      load: () => Promise.reject(new Error('Instellingen-board mist de rij(en): HQ ADRES')),
      env: {},
      sleep: noSleep,
    });

    await expect(cache.read()).rejects.toThrow(/HQ ADRES/);
    // And the next caller sees the sentinel, not a silent retry storm.
    await expect(cache.read()).rejects.toThrow(/Instellingen/);
  });

  it('re-reads once the short failure window has passed', async () => {
    let now = 1_000_000;
    const kv = createMemoryKvStore(() => now);
    let attempts = 0;
    const cache = createCachedSettings({
      kv,
      boardId: '123',
      env: {},
      sleep: noSleep,
      load: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(snapshot('123'));
      },
    });

    await expect(cache.read()).rejects.toThrow('boom');

    // The failure sentinel is short on purpose — a blip must not poison all three QStash
    // attempts into a terminal FOUT. It happens to equal the data TTL today; it is a
    // separate constant so that stays true if the data TTL is ever raised.
    now += 31_000;
    await expect(cache.read()).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });

  /**
   * The property the TTL exists for, from the editor's side: change a value on the
   * board, and a recalculation shortly after uses it. Pinned as behaviour rather than
   * as a number, so the constant can move without silently changing what ITG experiences.
   */
  it('picks up an edited value once the short TTL has passed', async () => {
    let now = 1_000_000;
    const kv = createMemoryKvStore(() => now);
    let rate = 23;
    const cache = createCachedSettings({
      kv,
      boardId: '123',
      env: {},
      sleep: noSleep,
      load: () => {
        const s = snapshot('123');
        return Promise.resolve({ ...s, app: { ...s.app, travelRateTrainerCentsPerKm: rate } });
      },
    });

    expect((await cache.read()).app.travelRateTrainerCentsPerKm).toBe(23);

    // Someone edits REISTARIEF TRAINERS on the board.
    rate = 50;
    // Still the cached value a moment later — that is the burst protection working.
    now += 5_000;
    expect((await cache.read()).app.travelRateTrainerCentsPerKm).toBe(23);

    // And picked up shortly after, rather than minutes later.
    now += SETTINGS_TTL_MS;
    expect((await cache.read()).app.travelRateTrainerCentsPerKm).toBe(50);
  });

  it('treats an entry written by an older shape as a miss, not as config', async () => {
    const kv = createMemoryKvStore();
    // The key the CURRENT deployment scope produces — seeding the old one would make
    // this pass because nothing was found, not because `decode` rejected the shape.
    await kv.set('settings:local:dev:123', JSON.stringify({ app: { hqAddress: 'x' } }), {
      ttlMs: 60_000,
    });
    const cache = createCachedSettings({
      kv,
      boardId: '123',
      load: () => Promise.resolve(snapshot('123')),
      env: {},
      sleep: noSleep,
    });

    expect((await cache.read()).app.travelRateTrainerCentsPerKm).toBe(23);
  });
});
