/**
 * The roll-up behind the trainer overview tab: the flat trainer×thema rows the nightly
 * job writes, grouped into one entry per trainer with the themes underneath.
 *
 * Pure, and separate from the screen on purpose. Two of these numbers are easy to get
 * wrong in ways that still look plausible on a table — a zero that means "never
 * evaluated" and a training count that double-counts — so they are worth pinning apart
 * from anything that needs a browser.
 *
 * Names appear nowhere here. Trainer and thema are external ids; the view resolves them
 * client-side through the planner's own Monday session, so the server never holds a
 * roster of who scored what.
 */

import { trainerOverallAvg } from '@lib/calc';

import type { BoardQualification, TrainerThemaStatRow } from './types';

export interface OverviewThemeRow {
  readonly themaExternalId: string;
  /** Null means "no grades", never "a zero". */
  readonly weightedAvg: number | null;
  readonly evaluationCount: number;
  /** Trainings on this theme. Meaningful per theme; see the trainer row for why. */
  readonly timesTaught: number;
  readonly qualification: BoardQualification;
}

export interface OverviewTrainerRow {
  readonly trainerExternalId: string;
  /** Weighted by evaluation count across the themes. Null when there are no grades. */
  readonly overallAvg: number | null;
  /**
   * The evaluations the average is BUILT ON, not every response ever attributed.
   *
   * A theme can hold responses whose grade cell was blank — 13 such rows exist in the
   * live NL export — and those are excluded from the denominator by
   * `trainerOverallAvg`. Counting them here would put a number next to the average that
   * cannot produce it, which is the kind of small inconsistency that costs an hour to
   * explain in an evaluation gesprek.
   */
  readonly evaluationCount: number;
  /** How many themes this trainer has a row for. */
  readonly themeCount: number;
  /**
   * Distinct trainings, or **null when nobody has told us**.
   *
   * Deliberately not derived from the theme rows. The nightly job counts +1 per trainer
   * PER THEME, so a training covering two themes lands in both — summing turns ten
   * trainings into seventeen, and taking the maximum only ever gives a lower bound.
   * Airtable kept this as its own rollup for the same reason. Until the job supplies a
   * real count this stays null and the column stays empty, which is the honest answer.
   */
  readonly trainingCount: number | null;
  readonly themes: readonly OverviewThemeRow[];
}

/** Busiest theme first, then by id so the order never depends on Redis. */
function byEvaluationsThenId(a: OverviewThemeRow, b: OverviewThemeRow): number {
  return (
    b.evaluationCount - a.evaluationCount || a.themaExternalId.localeCompare(b.themaExternalId)
  );
}

/**
 * @param rows the whole `evalstats:v1` set.
 * @param trainingCounts distinct trainings per trainer, when the job has computed them.
 */
export function buildTrainerOverview(
  rows: readonly TrainerThemaStatRow[],
  trainingCounts?: ReadonlyMap<string, number>
): readonly OverviewTrainerRow[] {
  const byTrainer = new Map<string, OverviewThemeRow[]>();

  for (const row of rows) {
    const themes = byTrainer.get(row.trainerExternalId) ?? [];
    themes.push({
      themaExternalId: row.themaExternalId,
      weightedAvg: row.weightedAvg,
      evaluationCount: row.evaluationCount,
      timesTaught: row.timesTaught,
      qualification: row.qualification,
    });
    byTrainer.set(row.trainerExternalId, themes);
  }

  return [...byTrainer.entries()]
    .map(([trainerExternalId, themes]) => {
      const sorted = [...themes].sort(byEvaluationsThenId);
      const evaluationCount = sorted.reduce(
        (sum, theme) => sum + (theme.weightedAvg === null ? 0 : theme.evaluationCount),
        0
      );
      /**
       * One formula with the recommendations view, so the same trainer cannot read 8,4
       * in one place and 8,1 in the other. The null is ours: `trainerOverallAvg` answers
       * 0 for a trainer with no grades, and a 0 under a column headed "Cijfer" would
       * report every unevaluated trainer as the worst on the roster.
       */
      const overall = trainerOverallAvg(
        sorted.map((theme) => ({
          weightedAvg: theme.weightedAvg,
          totalEvaluations: theme.evaluationCount,
        }))
      );

      return {
        trainerExternalId,
        overallAvg: evaluationCount === 0 ? null : overall,
        evaluationCount,
        themeCount: sorted.length,
        trainingCount: trainingCounts?.get(trainerExternalId) ?? null,
        themes: sorted,
      };
    })
    .sort((a, b) => a.trainerExternalId.localeCompare(b.trainerExternalId));
}
