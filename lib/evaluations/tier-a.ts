/**
 * Tier A parity: does our roll-up reproduce Airtable's `Trainer Thema Stats`?
 *
 * Extracted from the test so the SEED can run the same check before it writes. A gate
 * that only exists as a test is a gate the production path never passes through, and
 * `--apply` was previously happy to publish on a row-count comparison alone — which
 * cannot see a wrong average, a wrong count, or a broken join.
 *
 * The tier feeds the roll-up Airtable's OWN per-training aggregates and its OWN
 * completion signal, so the only thing under test is our arithmetic. Source drift is a
 * different question, deliberately not asked here.
 */

import { trainerOverallAvg } from '@lib/calc';

import { computeTrainerThemaStats } from './stats';

import type { TrainerThemaStatRow, TrainingAggregate, TrainingHistoryEntry } from './types';

/**
 * These sentinels drive `isCompleted` to the answer Airtable already gave, so the
 * completion RULE is held constant and only the arithmetic varies.
 */
const PAST = '2000-01-01';
const FUTURE = '2999-01-01';
const TODAY = '2026-01-01';

/** One Airtable record, as the snapshot stores it. */
export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

export interface TierAMismatch {
  readonly statsRowId: string;
  readonly field:
    | 'weightedAvg'
    | 'evaluationCount'
    | 'timesTaught'
    | 'missing'
    | 'extra'
    | 'trainerOverall';
  readonly airtable: number;
  readonly ours: number | null;
}

export interface TierAResult {
  /** Airtable rows our roll-up also produces — the fair comparison set. */
  readonly compared: number;
  /**
   * Rows Airtable has that we do not, PROVEN empty: zero trainings and zero
   * evaluations. Anything else is a `missing` mismatch, not a free pass.
   */
  readonly notProduced: number;
  readonly mismatches: readonly TierAMismatch[];
  /** Mismatches outside the allowlist. Non-empty means STOP. */
  readonly unexplained: readonly TierAMismatch[];
  /** Trainer-wide averages compared — ranking layer 3 rides on these. */
  readonly trainersCompared: number;
}

/**
 * The comparison set must be big enough to mean something.
 *
 * Without this the gate has a trivially fail-open shape: an empty or malformed snapshot,
 * or a regression that drops every historical pair, compares zero rows, finds zero
 * mismatches, and approves the seed. Measured live: 679 rows overlap.
 */
export const MIN_COMPARED_ROWS = 500;

/**
 * And the trainer-wide corpus must be present too.
 *
 * The row minimum says nothing about `trainers.json`: with valid training and stats
 * snapshots but an empty trainers file, `trainersCompared` is 0, no mismatch is raised,
 * and the seed publishes having never checked ranking layer 3 at all. Measured live: 80.
 */
export const MIN_COMPARED_TRAINERS = 50;

/**
 * Pairs OUR roll-up produces that Airtable has no row for.
 *
 * Airtable's stats table is maintained by Flow 5, which is `active: false` — so a pair
 * whose first training completed recently never got a row. That is Airtable being
 * incomplete rather than us inventing history, but it is allowlisted by exact pair and
 * exact figures so a genuine phantom cannot hide behind it.
 */
export const KNOWN_EXTRA_PAIRS: ReadonlyMap<string, { evaluationCount: number; timesTaught: number }> =
  new Map([['rec18QfYK3jTdEkFu|reclzCRXoe1e5WtYQ', { evaluationCount: 0, timesTaught: 1 }]]);

/**
 * Rows where Airtable is known to be wrong, each cause established by inspection.
 *
 * - `stale`: the stats row was last recomputed before a training completed.
 * - `counts_unfinished`: Flow 9 increments `timesGiven` for the training it is
 *   processing without checking its status — its own docs call this "same-batch status
 *   blindness" — so a training months in the future already counts.
 *
 * Allowlisted BY ROW, not by count: a new disagreement fails even though the number of
 * failures is unchanged.
 */
export const KNOWN_TIMES_GIVEN_DIFFS: ReadonlyMap<string, { airtable: number; ours: number }> =
  new Map([
    // stale: recomputed before a 2026-07-21 training completed
    ['rec1xM6bHhORiT2w2', { airtable: 1, ours: 2 }],
    ['recaEFSB3UOBgG8rm', { airtable: 1, ours: 2 }],
    ['recx4xBOgnRjarsnY', { airtable: 0, ours: 1 }],
    // counts_unfinished: Flow 9 counted a training that had not happened
    ['recST2raWzgXtHZ7P', { airtable: 2, ours: 3 }],
    ['receCauH9PDL1Jivp', { airtable: 2, ours: 1 }],
  ]);

/**
 * Allowlisted by row AND by the exact pair of values.
 *
 * By id alone, any future regression on these five rows is waved through whatever its
 * magnitude — the allowlist would suppress `timesTaught: 400` as readily as the known
 * off-by-one. Pinning both numbers means only the discrepancy we actually inspected is
 * forgiven.
 */
function isKnownDiff(mismatch: TierAMismatch): boolean {
  if (mismatch.field !== 'timesTaught') {
    return false;
  }
  const known = KNOWN_TIMES_GIVEN_DIFFS.get(mismatch.statsRowId);
  return known !== undefined && known.airtable === mismatch.airtable && known.ours === mismatch.ours;
}

const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

export function runTierA(
  trainingen: readonly AirtableRecord[],
  stats: readonly AirtableRecord[],
  /**
   * Required in effect: an empty list fails {@link MIN_COMPARED_TRAINERS}. Passing it
   * explicitly keeps a caller from omitting the trainer-wide check by accident.
   */
  trainers: readonly AirtableRecord[]
): TierAResult {
  const history: TrainingHistoryEntry[] = trainingen.map((r) => ({
    trainingItemId: r.id,
    datum: r.fields.Status === 'Afgerond' ? PAST : FUTURE,
    trainerExternalIds: arr(r.fields.Trainer),
    themaExternalIds: arr(r.fields.Thema),
  }));
  const aggregates: TrainingAggregate[] = trainingen
    .filter((r) => num(r.fields['Evaluation count']) > 0)
    .map((r) => ({
      trainingItemId: r.id,
      // Airtable stores 0 for "no grade"; our contract is null.
      avgOverallGrade:
        num(r.fields['Avg Overall grade']) > 0 ? num(r.fields['Avg Overall grade']) : null,
      evaluationCount: num(r.fields['Evaluation count']),
      matchedCodes: [],
    }));

  const { rows } = computeTrainerThemaStats({
    history,
    aggregates,
    qualifications: [],
    today: TODAY,
  });
  const ours = new Map(rows.map((r) => [`${r.trainerExternalId}|${r.themaExternalId}`, r]));

  const mismatches: TierAMismatch[] = [];
  let compared = 0;
  let notProduced = 0;

  for (const record of stats) {
    const mine = ours.get(`${arr(record.fields.Trainer)[0]}|${arr(record.fields.Thema)[0]}`);
    if (mine === undefined) {
      /**
       * An absent row is only forgivable when it is PROVABLY empty. Airtable keeps
       * qualification-only rows we deliberately do not produce in this tier (no
       * qualifications are fed in), and those carry zero trainings and zero evaluations.
       * A row with either is history we should have reproduced and did not — that is a
       * regression, not a category difference.
       */
      const given = num(record.fields['Times Given']);
      const evals = num(record.fields['Total Evalutions']);
      if (given === 0 && evals === 0) {
        notProduced += 1;
      } else {
        mismatches.push({
          statsRowId: record.id,
          field: 'missing',
          airtable: given,
          ours: null,
        });
      }
      continue;
    }
    compared += 1;

    // Airtable has no way to say "no evaluations", so its 0 is our null.
    const theirAvg = num(record.fields['Weighted Avg']);
    if (Math.abs(theirAvg - (mine.weightedAvg ?? 0)) >= 1e-9) {
      mismatches.push({
        statsRowId: record.id,
        field: 'weightedAvg',
        airtable: theirAvg,
        ours: mine.weightedAvg,
      });
    }
    const theirEvals = num(record.fields['Total Evalutions']);
    if (theirEvals !== mine.evaluationCount) {
      mismatches.push({
        statsRowId: record.id,
        field: 'evaluationCount',
        airtable: theirEvals,
        ours: mine.evaluationCount,
      });
    }
    const theirGiven = num(record.fields['Times Given']);
    if (theirGiven !== mine.timesTaught) {
      mismatches.push({
        statsRowId: record.id,
        field: 'timesTaught',
        airtable: theirGiven,
        ours: mine.timesTaught,
      });
    }
  }

  /**
   * Trainer-wide averages — `Overall Avg Score`, which is ranking layer 3.
   *
   * The per-theme figures can all agree while the roll-up across a trainer's themes is
   * wrong (that is exactly the numerator/denominator defect `contributingEvaluations`
   * fixed), so a gate that stops at the theme level does not cover the value the
   * ranking actually sorts on.
   */
  let trainersCompared = 0;
  const byTrainer = new Map<string, TrainerThemaStatRow[]>();
  for (const row of rows) {
    byTrainer.set(row.trainerExternalId, [...(byTrainer.get(row.trainerExternalId) ?? []), row]);
  }
  for (const trainer of trainers) {
    const mine = byTrainer.get(trainer.id);
    const theirs = num(trainer.fields['Overall Avg Score']);
    if (mine === undefined) {
      // A trainer with no rows on our side and no evaluations on theirs is agreement.
      if (theirs !== 0) {
        mismatches.push({
          statsRowId: trainer.id,
          field: 'trainerOverall',
          airtable: theirs,
          ours: null,
        });
      }
      continue;
    }
    trainersCompared += 1;
    const oursOverall = trainerOverallAvg(
      mine.map((row) => ({ weightedAvg: row.weightedAvg, totalEvaluations: row.evaluationCount }))
    );
    /**
     * Full precision, the same tolerance as the per-theme comparison. The snapshot
     * stores values like `7.942972972972973` — this is not a two-decimal display field,
     * and it feeds ranking layer 3 directly, so a 0.005 window would wave a real
     * regression through. Measured worst difference across all 80 trainers: 1.8e-15.
     */
    if (Math.abs(theirs - oursOverall) >= 1e-9) {
      mismatches.push({
        statsRowId: trainer.id,
        field: 'trainerOverall',
        airtable: theirs,
        ours: oursOverall,
      });
    }
  }

  /**
   * The reverse direction: rows only WE produce.
   *
   * Checking Airtable → ours alone means a regression that keeps every expected pair and
   * additionally emits phantom trainer/theme rows passes the gate — and those rows are
   * then published and rank.
   */
  const expectedPairs = new Set(
    stats.map((s) => `${arr(s.fields.Trainer)[0]}|${arr(s.fields.Thema)[0]}`)
  );
  for (const row of rows) {
    const key = `${row.trainerExternalId}|${row.themaExternalId}`;
    if (expectedPairs.has(key)) {
      continue;
    }
    const known = KNOWN_EXTRA_PAIRS.get(key);
    if (
      known !== undefined &&
      known.evaluationCount === row.evaluationCount &&
      known.timesTaught === row.timesTaught
    ) {
      continue;
    }
    mismatches.push({
      statsRowId: key,
      field: 'extra',
      airtable: 0,
      ours: row.timesTaught,
    });
  }

  const unexplained = mismatches.filter((m) => !isKnownDiff(m));
  if (compared < MIN_COMPARED_ROWS) {
    unexplained.push({
      statsRowId: '(gate: too few rows compared)',
      field: 'missing',
      airtable: MIN_COMPARED_ROWS,
      ours: compared,
    });
  }
  if (trainersCompared < MIN_COMPARED_TRAINERS) {
    unexplained.push({
      statsRowId: '(gate: too few trainers compared)',
      field: 'trainerOverall',
      airtable: MIN_COMPARED_TRAINERS,
      ours: trainersCompared,
    });
  }

  return { compared, notProduced, mismatches, unexplained, trainersCompared };
}
