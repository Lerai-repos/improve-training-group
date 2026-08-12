import { describe, expect, it } from 'vitest';

import { computeScores } from '../scores';
import type { TrainerThemeEval } from '../types';

const ev = (
  trainer: string,
  thema: string,
  avg: number | null,
  count: number
): TrainerThemeEval => ({
  trainerExternalId: trainer,
  themaExternalId: thema,
  avgOverallGrade: avg,
  evaluationCount: count,
});

describe('computeScores', () => {
  it('empty snapshots → themeAvgScore null, overallAvgScore 0 (M3 inert)', () => {
    expect(computeScores('t1', ['th1'], [])).toEqual({ themeAvgScore: null, overallAvgScore: 0 });
  });

  it('themeAvgScore weights only the training’s themes; overall spans all themes', () => {
    const evals = [
      ev('t1', 'th1', 8, 2), // in training
      ev('t1', 'th1', 6, 2), // in training
      ev('t1', 'th2', 10, 4), // NOT a training theme, but counts to overall
    ];
    const s = computeScores('t1', ['th1'], evals);
    expect(s.themeAvgScore).toBe(7); // (8×2 + 6×2) / 4
    // overall: th1 weighted=7 (evals 4), th2 weighted=10 (evals 4) → (7×4 + 10×4)/8 = 8.5
    expect(s.overallAvgScore).toBe(8.5);
  });

  it('ignores another trainer’s evals', () => {
    const s = computeScores('t1', ['th1'], [ev('t2', 'th1', 9, 5)]);
    expect(s).toEqual({ themeAvgScore: null, overallAvgScore: 0 });
  });

  /**
   * The numerator and the denominator have to agree about which rows counted.
   *
   * A theme with BOTH a graded and an ungraded training is the case that bites:
   * `weightedThemeAvg` skips the ungraded row, so the average is 8 — but a
   * `totalEvaluations` summed over every row says that 8 is backed by 100 evaluations
   * instead of 4, and the theme then dominates the trainer's overall average. (A theme
   * that is ungraded *throughout* is harmless: `trainerOverallAvg` drops a null-average
   * stat outright, which is why this went unnoticed.)
   */
  it('weights a theme by the evaluations that produced its average, not by all of them', () => {
    const evals = [
      ev('t1', 'th1', 8, 4),
      ev('t1', 'th1', null, 96), // responses, no parseable grade — no score, no weight
      ev('t1', 'th2', 6, 4),
    ];

    const s = computeScores('t1', ['th1'], evals);

    expect(s.themeAvgScore).toBe(8);
    // (8×4 + 6×4) / 8 = 7. Counting the 96 ungraded responses gives 7.92.
    expect(s.overallAvgScore).toBe(7);
  });
});
