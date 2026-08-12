import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '@lib/recommend/kv';

import { STATS_TTL_MS, createStatsStore } from '../stats-store';

import type { TrainerThemaStatRow } from '../types';

const row = (over: Partial<TrainerThemaStatRow> = {}): TrainerThemaStatRow => ({
  trainerExternalId: 't1',
  themaExternalId: 'th1',
  weightedAvg: 7.8,
  evaluationCount: 12,
  timesTaught: 3,
  qualification: 'Groen',
  ...over,
});

const snapshot = (rows: TrainerThemaStatRow[], sources: Record<string, number> = {}) => ({
  rows,
  writtenAt: '2026-08-12T02:45:00.000Z',
  today: '2026-08-12',
  sources,
});

describe('createStatsStore', () => {
  it('round-trips a row', async () => {
    const kv = createMemoryKvStore();
    const store = createStatsStore(kv);

    await store.write(snapshot([row()]));

    expect(await store.read()).toEqual({
      rows: [row()],
      writtenAt: '2026-08-12T02:45:00.000Z',
      today: '2026-08-12',
      sources: {},
    });
  });

  it('returns null before anything has been written', async () => {
    expect(await createStatsStore(createMemoryKvStore()).read()).toBeNull();
  });

  /** `null` means "no grades" and must never come back as a zero. */
  it('preserves a null average distinctly from a zero one', async () => {
    const kv = createMemoryKvStore();
    const store = createStatsStore(kv);

    await store.write(
      snapshot([
        row({ themaExternalId: 'none', weightedAvg: null, evaluationCount: 0, timesTaught: 0 }),
        row({ themaExternalId: 'zero', weightedAvg: 0, evaluationCount: 4, timesTaught: 1 }),
      ])
    );

    const read = await store.read();
    expect(read?.rows[0].weightedAvg).toBeNull();
    expect(read?.rows[1].weightedAvg).toBe(0);
  });

  it('rewrites the whole set rather than merging', async () => {
    const kv = createMemoryKvStore();
    const store = createStatsStore(kv);

    await store.write(snapshot([row({ themaExternalId: 'a' }), row({ themaExternalId: 'b' })]));
    await store.write(snapshot([row({ themaExternalId: 'a' })]));

    expect((await store.read())?.rows.map((r) => r.themaExternalId)).toEqual(['a']);
  });

  it('expires, so a permanently dead job stops serving numbers nobody maintains', async () => {
    let now = 1_000;
    const kv = createMemoryKvStore(() => now);
    const store = createStatsStore(kv, 5_000);

    await store.write(snapshot([row()]));
    now += 4_999;
    expect(await store.read()).not.toBeNull();
    now += 2;
    expect(await store.read()).toBeNull();
  });

  /** The baseline travels WITH the data, so it cannot advance on its own. */
  it('carries the source counts the next run compares against', async () => {
    const kv = createMemoryKvStore();
    const store = createStatsStore(kv);

    await store.write(snapshot([row()], { 'sheet:nl': 2985, 'responses:total': 3713 }));

    expect((await store.read())?.sources).toEqual({ 'sheet:nl': 2985, 'responses:total': 3713 });
  });

  it('defaults to a 30-day life', () => {
    expect(STATS_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  describe('refusing a record it cannot trust', () => {
    /**
     * The reason every failure here throws rather than returning null: for the engine an
     * absent pair means "never taught". A corrupt record read as "no statistics" would
     * turn every trainer into a confident zero across the whole board.
     */
    it('throws on invalid JSON', async () => {
      const kv = createMemoryKvStore();
      await kv.set('evalstats:v1', '{ not json');

      await expect(createStatsStore(kv).read()).rejects.toThrow(/not valid JSON/);
    });

    it('throws on a record from a shape it does not know', async () => {
      const kv = createMemoryKvStore();
      await kv.set('evalstats:v1', JSON.stringify({ v: 1, rows: 'nope' }));

      await expect(createStatsStore(kv).read()).rejects.toThrow(/unreadable shape/);
    });

    /** A tuple is positional, so a wrong arity must fail rather than shift every value. */
    it('throws when a row tuple has the wrong arity', async () => {
      const kv = createMemoryKvStore();
      await kv.set(
        'evalstats:v1',
        JSON.stringify({ v: 1, writtenAt: 'x', today: 'y', sources: {}, rows: [['t1', 'th1', 7.8, 12]] })
      );

      await expect(createStatsStore(kv).read()).rejects.toThrow(/unreadable shape/);
    });

    it('throws on an unknown qualification label', async () => {
      const kv = createMemoryKvStore();
      await kv.set(
        'evalstats:v1',
        JSON.stringify({
          v: 1,
          writtenAt: 'x',
          today: 'y',
          sources: {},
          rows: [['t1', 'th1', 7.8, 12, 3, 'Paars']],
        })
      );

      await expect(createStatsStore(kv).read()).rejects.toThrow(/unreadable shape/);
    });

    it('throws on two rows for one pair', async () => {
      const kv = createMemoryKvStore();
      const store = createStatsStore(kv);
      await store.write(snapshot([row(), row({ evaluationCount: 99 })]));

      await expect(store.read()).rejects.toThrow(/two rows for t1\|th1/);
    });

    /** A record written by a newer shape lives under a different key, so it reads as absent. */
    it('does not see a v2 record', async () => {
      const kv = createMemoryKvStore();
      await kv.set('evalstats:v2', JSON.stringify({ v: 2 }));

      expect(await createStatsStore(kv).read()).toBeNull();
    });
  });

  /**
   * The tuple encoding exists to keep this value small enough to fetch on the
   * recommendation path. At the measured live size — 2.191 rows — the object form is
   * roughly four times bigger.
   */
  it('keeps the live-sized payload well under a megabyte', () => {
    const store = createStatsStore(createMemoryKvStore());
    const many = Array.from({ length: 2_191 }, (_, i) =>
      row({ trainerExternalId: `trainer-${i % 200}`, themaExternalId: `thema-${i}` })
    );

    const bytes = store.sizeOf(many);

    expect(bytes).toBeLessThan(200_000);
    expect(bytes).toBeGreaterThan(1_000);
  });
});
