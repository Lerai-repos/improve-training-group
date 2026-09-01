import { describe, expect, it } from 'vitest';

import { createMemoryKvStore } from '@lib/recommend/kv';

import { OVERVIEW_STALE_AFTER_MS, resolveTrainerOverview } from '../overview-view';
import { createStatsStore } from '../stats-store';

import type { TrainerThemaStatRow } from '../types';

const row = (over: Partial<TrainerThemaStatRow> = {}): TrainerThemaStatRow => ({
  trainerExternalId: 't1',
  themaExternalId: 'th1',
  weightedAvg: 8,
  evaluationCount: 4,
  timesTaught: 2,
  qualification: 'Groen',
  ...over,
});

const WRITTEN_AT = '2026-08-30T02:45:00.000Z';

const storeWith = async (rows: TrainerThemaStatRow[], trainingsPerTrainer = {}) => {
  const store = createStatsStore(createMemoryKvStore());
  await store.write({
    rows,
    writtenAt: WRITTEN_AT,
    today: '2026-08-30',
    sources: {},
    trainingsPerTrainer,
  });
  return store;
};

const at = (iso: string) => () => Date.parse(iso);

describe('resolveTrainerOverview', () => {
  /**
   * Nothing written yet is a real state — a fresh environment, or the very first night.
   * It has to read as "no statistics", never as "every trainer scored nothing".
   */
  it('reports an empty roster when the nightly job has never run', async () => {
    const store = createStatsStore(createMemoryKvStore());

    const payload = await resolveTrainerOverview(store, at('2026-08-30T09:00:00.000Z'));

    expect(payload).toEqual({ writtenAt: null, stale: false, trainers: [] });
  });

  it('rolls the stored rows up per trainer', async () => {
    const store = await storeWith([row(), row({ themaExternalId: 'th2', weightedAvg: 6, evaluationCount: 4 })]);

    const payload = await resolveTrainerOverview(store, at('2026-08-30T09:00:00.000Z'));

    expect(payload.trainers).toHaveLength(1);
    expect(payload.trainers[0]?.overallAvg).toBe(7);
    expect(payload.writtenAt).toBe(WRITTEN_AT);
  });

  it('passes the stored training counts through', async () => {
    const store = await storeWith([row()], { t1: 5 });

    const payload = await resolveTrainerOverview(store, at('2026-08-30T09:00:00.000Z'));

    expect(payload.trainers[0]?.trainingCount).toBe(5);
  });

  /**
   * A view marks staleness, it does not refuse. The engine's rule is the opposite — it
   * throws rather than rank on old numbers — because a wrong ranking silently changes
   * who gets asked, while a dated table with its date on it is merely dated.
   */
  it('flags a stale record but still serves it', async () => {
    const store = await storeWith([row()]);

    const justPast = new Date(Date.parse(WRITTEN_AT) + OVERVIEW_STALE_AFTER_MS + 1).toISOString();
    const payload = await resolveTrainerOverview(store, at(justPast));

    expect(payload.stale).toBe(true);
    expect(payload.trainers).toHaveLength(1);
  });

  /**
   * One missed night must not shout. The job runs at 02:45, so a record read the next
   * morning after a single failure is about 30 hours old — inside the window on
   * purpose, so the warning means "this has been broken for a while" rather than
   * "something hiccuped once".
   */
  it('stays quiet after a single missed night', async () => {
    const store = await storeWith([row()]);

    const payload = await resolveTrainerOverview(store, at('2026-08-31T09:00:00.000Z'));

    expect(payload.stale).toBe(false);
  });
});
