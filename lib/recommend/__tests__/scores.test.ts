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
});
