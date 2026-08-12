import { describe, expect, it } from 'vitest';

import { STATS_TTL_MS, createStatsStore } from '@lib/evaluations';

import {
  STATS_MAX_AGE_MS,
  evalStatsEnabled,
  readEvalStats,
  readTrainerThemeStats,
} from '../eval-stats';
import { createMemoryKvStore } from '../kv';

import type { TrainerThemaStatRow } from '@lib/evaluations';

const row = (over: Partial<TrainerThemaStatRow> = {}): TrainerThemaStatRow => ({
  trainerExternalId: 't1',
  themaExternalId: 'th1',
  weightedAvg: 7.8,
  evaluationCount: 12,
  timesTaught: 3,
  qualification: 'Groen',
  ...over,
});

/**
 * `writtenAt` is stamped from the REAL clock, not a fixed date.
 *
 * `readEvalStats` consults `Date.now()` for the staleness check, so a hard-coded
 * timestamp turns every unrelated test in this file into a time bomb: they pass until
 * the fixture is a fortnight old and then start failing for a reason that has nothing to
 * do with what they assert. The staleness tests below inject their own clock instead.
 */
const write = async (
  kv: ReturnType<typeof createMemoryKvStore>,
  rows: TrainerThemaStatRow[],
  writtenAt: string = new Date().toISOString()
) => {
  await createStatsStore(kv).write({ rows, writtenAt, today: writtenAt.slice(0, 10), sources: {} });
};

describe('readTrainerThemeStats', () => {
  it('projects a stored row onto the engine’s shape', async () => {
    const kv = createMemoryKvStore();
    await write(kv, [row()]);

    expect(await readEvalStats(kv)).toEqual([
      {
        trainerExternalId: 't1',
        themaExternalId: 'th1',
        avgOverallGrade: 7.8,
        evaluationCount: 12,
        timesTaught: 3,
      },
    ]);
  });

  /** `null` is "no grades" and must survive; a 0 would rank as a bad average. */
  it('carries a null average through unchanged', async () => {
    const kv = createMemoryKvStore();
    await write(kv, [row({ weightedAvg: null, evaluationCount: 0, timesTaught: 0 })]);

    expect((await readEvalStats(kv))[0].avgOverallGrade).toBeNull();
  });

  /**
   * Never an empty list. Empty is indistinguishable from "nobody has ever been
   * evaluated", so a missing record would silently rerank every list and report an
   * evaluated trainer as inexperienced — the failure this whole contract exists to
   * prevent.
   */
  it('throws when nothing has ever been written, rather than returning nothing', async () => {
    await expect(readEvalStats(createMemoryKvStore())).rejects.toThrow(/eval-stats cron/);
  });

  it('propagates a corrupt record rather than degrading to empty', async () => {
    const kv = createMemoryKvStore();
    await kv.set('evalstats:v1', '{ not json');

    await expect(readEvalStats(kv)).rejects.toThrow(/not valid JSON/);
  });

  it('reads through a store that was handed in', async () => {
    const kv = createMemoryKvStore();
    await write(kv, [row(), row({ themaExternalId: 'th2' })]);

    expect(await readTrainerThemeStats(createStatsStore(kv))).toHaveLength(2);
  });
});

describe('staleness', () => {
  /**
   * The record lives 30 days, so a dead cron leaves it servable for a month while the
   * view presents the numbers as current — nothing downstream carries the age. Refusing
   * inside the TTL makes that deterministic instead of a cliff, and loud instead of
   * silent: "the statistics are stale, fix the cron" beats ranking a month-old picture.
   */
  const WRITTEN_AT = '2026-08-12T02:45:00.000Z';
  const writtenMs = Date.parse(WRITTEN_AT);

  it('refuses a snapshot past the age limit', async () => {
    const kv = createMemoryKvStore();
    await write(kv, [row()], WRITTEN_AT);

    await expect(
      readTrainerThemeStats(createStatsStore(kv), () => writtenMs + STATS_MAX_AGE_MS + 1)
    ).rejects.toThrow(/days old.*cron has stopped running/s);
  });

  it('serves a snapshot inside the limit', async () => {
    const kv = createMemoryKvStore();
    await write(kv, [row()], WRITTEN_AT);

    await expect(
      readTrainerThemeStats(createStatsStore(kv), () => writtenMs + STATS_MAX_AGE_MS - 1)
    ).resolves.toHaveLength(1);
  });

  it('stops before the record would expire, so the failure is deterministic', () => {
    expect(STATS_MAX_AGE_MS).toBeLessThan(STATS_TTL_MS);
  });

  it('refuses a record whose timestamp cannot be read', async () => {
    const kv = createMemoryKvStore();
    await write(kv, [row()], 'niet een datum');

    await expect(readTrainerThemeStats(createStatsStore(kv))).rejects.toThrow(/unreadable writtenAt/);
  });
});

describe('evalStatsEnabled', () => {
  /**
   * A release gate, not configuration. Filling these fields wakes ranking layers 2 and
   * 3, so every group of trainers tied on cost reorders — that gets approved by looking
   * at `recommend:parity` with the flag on, then switched on for everyone.
   */
  it('is off unless the flag is exactly "1"', () => {
    expect(evalStatsEnabled({})).toBe(false);
    expect(evalStatsEnabled({ EVAL_STATS_ENABLED: '' })).toBe(false);
    expect(evalStatsEnabled({ EVAL_STATS_ENABLED: 'true' })).toBe(false);
    expect(evalStatsEnabled({ EVAL_STATS_ENABLED: '0' })).toBe(false);
  });

  it('is on for "1"', () => {
    expect(evalStatsEnabled({ EVAL_STATS_ENABLED: '1' })).toBe(true);
  });
});
