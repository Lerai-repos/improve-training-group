import { describe, expect, it } from 'vitest';

import { buildTrainerOverview } from '../overview';

import type { TrainerThemaStatRow } from '../types';

/**
 * The roll-up behind the trainer overview tab.
 *
 * Everything here is arithmetic over the rows the nightly job already writes; the point
 * of testing it apart from the screen is that two of the numbers are easy to get wrong
 * in ways that look plausible — see the training-count and no-grades cases below.
 */

const row = (
  trainer: string,
  thema: string,
  weightedAvg: number | null,
  evaluationCount: number,
  timesTaught = 1,
  qualification: TrainerThemaStatRow['qualification'] = 'Groen'
): TrainerThemaStatRow => ({
  trainerExternalId: trainer,
  themaExternalId: thema,
  weightedAvg,
  evaluationCount,
  timesTaught,
  qualification,
});

describe('buildTrainerOverview', () => {
  it('groups the flat rows into one entry per trainer', () => {
    const overview = buildTrainerOverview([
      row('t1', 'a', 8, 2),
      row('t2', 'a', 7, 1),
      row('t1', 'b', 9, 3),
    ]);

    expect(overview.map((t) => t.trainerExternalId)).toEqual(['t1', 't2']);
    expect(overview[0]?.themes.map((t) => t.themaExternalId)).toEqual(['b', 'a']);
  });

  /**
   * The overall figure IS a weighted roll-up of the theme rows — the same
   * `Sum(score x evals) / Sum(evals)` the recommendations view and Airtable both use —
   * so unlike the training count it may legitimately be derived from them.
   */
  it('weights the overall average by evaluation count, not by theme', () => {
    const overview = buildTrainerOverview([row('t1', 'a', 10, 1), row('t1', 'b', 5, 3)]);

    // (10*1 + 5*3) / 4 = 6.25, not the unweighted 7.5.
    expect(overview[0]?.overallAvg).toBeCloseTo(6.25);
    expect(overview[0]?.evaluationCount).toBe(4);
  });

  /**
   * `trainerOverallAvg` returns 0 for a trainer with no grades — legacy's rule, which
   * the recommendations view already documents. Rendering that 0 in a column headed
   * "Cijfer" would report every unevaluated trainer as the worst on the roster.
   */
  it('reports no grades as null rather than as a zero', () => {
    const overview = buildTrainerOverview([row('t1', 'a', null, 0), row('t1', 'b', null, 0)]);

    expect(overview[0]?.overallAvg).toBeNull();
    expect(overview[0]?.evaluationCount).toBe(0);
  });

  it('ignores a theme with a score but no evaluations behind it', () => {
    const overview = buildTrainerOverview([row('t1', 'a', 8, 2), row('t1', 'b', 9, 0)]);

    expect(overview[0]?.overallAvg).toBe(8);
    expect(overview[0]?.themeCount).toBe(2);
  });

  /**
   * The trap. The nightly job writes one row per trainer PER THEME, so a training that
   * covered two themes contributes a `timesTaught` to both. Summing them reports a
   * trainer who taught ten trainings as having taught seventeen.
   */
  it('never derives the training count from the theme rows', () => {
    const overview = buildTrainerOverview([
      row('t1', 'a', 8, 2, 6),
      row('t1', 'b', 8, 2, 4),
    ]);

    expect(overview[0]?.trainingCount).toBeNull();
    expect(overview[0]?.themes.map((t) => t.timesTaught)).toEqual([6, 4]);
  });

  it('uses the real training count when the nightly job supplied one', () => {
    const overview = buildTrainerOverview(
      [row('t1', 'a', 8, 2, 6), row('t1', 'b', 8, 2, 4)],
      new Map([['t1', 7]])
    );

    expect(overview[0]?.trainingCount).toBe(7);
  });

  it('carries the qualification through to the theme row', () => {
    const overview = buildTrainerOverview([row('t1', 'a', null, 0, 0, 'Grijs')]);

    expect(overview[0]?.themes[0]?.qualification).toBe('Grijs');
  });

  it('is stable and empty-safe', () => {
    expect(buildTrainerOverview([])).toEqual([]);
  });
});

/**
 * A theme can carry responses whose grade cell was blank — 13 such rows are in the live
 * NL export. They are excluded from the average's denominator, so they are excluded
 * from the count shown beside it too: the pair has to be able to produce the figure.
 */
describe('the count beside the average', () => {
  it('counts only the evaluations the average is built on', () => {
    const overview = buildTrainerOverview([row('t1', 'a', 8, 4), row('t1', 'b', null, 5)]);

    expect(overview[0]?.overallAvg).toBe(8);
    expect(overview[0]?.evaluationCount).toBe(4);
  });
});
