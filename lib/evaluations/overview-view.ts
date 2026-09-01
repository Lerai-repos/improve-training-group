/**
 * What the trainer overview tab asks for: the whole roster, rolled up, plus how old the
 * numbers are.
 *
 * Lives here rather than in the route so that everything the endpoint decides can be
 * tested without a Next request — the route is left with authorisation and JSON.
 *
 * No dependency on `@lib/recommend`. The engine has its own staleness rule and its own
 * constant; importing it would close the cycle this package is careful not to create,
 * and the two rules are deliberately different anyway (see below).
 */

import { buildTrainerOverview, type OverviewTrainerRow } from './overview';

import type { StatsStore } from './stats-store';

/**
 * How old the statistics may be before the tab says so.
 *
 * Two days, against the engine's fourteen, and the asymmetry is the point. The engine
 * REFUSES at its threshold because ranking on a month-old picture quietly changes who
 * gets asked to teach. A table only has to admit its age: it is read by a human who can
 * see the date, and being a day behind is normal for a nightly job.
 */
export const OVERVIEW_STALE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

export interface TrainerOverviewPayload {
  /** When the nightly job last wrote. Null when it never has. */
  readonly writtenAt: string | null;
  readonly stale: boolean;
  readonly trainers: readonly OverviewTrainerRow[];
}

export async function resolveTrainerOverview(
  store: StatsStore,
  now: () => number = Date.now
): Promise<TrainerOverviewPayload> {
  const snapshot = await store.read();
  if (snapshot === null) {
    // Never written is not "everyone scored nothing". The tab says so in words.
    return { writtenAt: null, stale: false, trainers: [] };
  }

  const trainingCounts = new Map(Object.entries(snapshot.trainingsPerTrainer));

  return {
    writtenAt: snapshot.writtenAt,
    stale: now() - Date.parse(snapshot.writtenAt) > OVERVIEW_STALE_AFTER_MS,
    trainers: buildTrainerOverview(snapshot.rows, trainingCounts),
  };
}
