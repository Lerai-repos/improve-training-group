/**
 * The engine's side of the evaluation statistics.
 *
 * One Redis read per execution, projected onto the shape `computeScores` and
 * `toStoredRows` already expect. This is the only edge from the engine to
 * `lib/evaluations`; the reverse edge does not exist, which is why the roll-up takes
 * qualifications as plain data rather than importing them from here.
 *
 * No cache. The board design needed one — six Monday calls per training, multiplied by
 * every training in a sweep — but a single Redis GET of ~60 KB does not, and a cache
 * would only add a staleness window plus a failure mode where an outage is remembered
 * as an empty index. Every run reads fresh.
 */

import { createStatsStore, type StatsStore } from '@lib/evaluations';

import type { KvStore } from './kv';
import type { TrainerThemeStat } from './types';

/**
 * Whether the engine uses the statistics at all.
 *
 * A release gate, not configuration. Filling these fields wakes up ranking layers 2 and
 * 3 (`lib/calc/rank.ts`: cost ↑, then theme average ↓, then overall average ↓), so every
 * group of trainers tied on cost reorders. That change gets approved by looking at
 * `pnpm recommend:parity` with the flag on, and THEN switched on for everyone. Delete
 * the flag once it is approved — it is not meant to live here.
 */
export function evalStatsEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.EVAL_STATS_ENABLED === '1';
}

/**
 * How old the statistics may be before the engine refuses to rank on them.
 *
 * The record lives for 30 days, so a cron that dies quietly leaves it servable for a
 * month while the view presents the numbers as current. Nothing downstream carries the
 * age — not the stored row, not the public DTO — so a planner cannot tell.
 *
 * 14 days is well inside that TTL: the engine stops before the record would expire,
 * which makes the failure deterministic rather than a cliff. And it fails LOUDLY, as a
 * retryable FOUT, because "the statistics are stale, fix the cron" is a better answer
 * than silently ranking a month-old picture. A nightly job that has not run for two
 * weeks is an outage, not a hiccup.
 */
export const STATS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Read the statistics, or throw.
 *
 * There is deliberately no "return [] on failure" path. An empty list is
 * indistinguishable from "nobody has ever been evaluated", so a Redis blip would
 * silently rerank every list and report a 40-evaluation trainer as inexperienced. The
 * store itself refuses a corrupt or ambiguous record for the same reason.
 */
export async function readTrainerThemeStats(
  store: StatsStore,
  now: () => number = Date.now,
  maxAgeMs: number = STATS_MAX_AGE_MS
): Promise<TrainerThemeStat[]> {
  const snapshot = await store.read();
  if (snapshot === null) {
    // Nothing has ever been written: the nightly job has not run, or its record expired
    // after 30 days of failures. Both are configuration problems, not "no evaluations".
    throw new Error(
      'No evaluation statistics have been written yet — run the eval-stats cron ' +
        '(or unset EVAL_STATS_ENABLED until it has)'
    );
  }
  const writtenAtMs = Date.parse(snapshot.writtenAt);
  if (Number.isNaN(writtenAtMs)) {
    throw new Error(`Evaluation statistics carry an unreadable writtenAt: "${snapshot.writtenAt}"`);
  }
  const ageMs = now() - writtenAtMs;
  if (ageMs > maxAgeMs) {
    const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
    throw new Error(
      `Evaluation statistics are ${days} days old (written ${snapshot.writtenAt}), past the ` +
        `${Math.floor(maxAgeMs / (24 * 60 * 60 * 1000))}-day limit — the eval-stats cron has ` +
        `stopped running. Refusing to rank on them rather than presenting them as current.`
    );
  }

  return snapshot.rows.map((row) => ({
    trainerExternalId: row.trainerExternalId,
    themaExternalId: row.themaExternalId,
    // `weightedAvg` is already round2'd by the nightly job, and null when there are no
    // grades — never 0. `computeScores` re-weights these, which for a single
    // pre-weighted row is the identity.
    avgOverallGrade: row.weightedAvg,
    evaluationCount: row.evaluationCount,
    timesTaught: row.timesTaught,
  }));
}

/** Convenience for the composition root: build the store and read it in one step. */
export function readEvalStats(kv: KvStore): Promise<TrainerThemeStat[]> {
  return readTrainerThemeStats(createStatsStore(kv));
}
