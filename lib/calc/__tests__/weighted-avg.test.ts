import { describe, expect, it } from 'vitest';

import { trainerOverallAvg, weightedThemeAvg } from '../weighted-avg';

describe('weightedThemeAvg', () => {
  it('weights by evaluation count, not a naive mean', () => {
    // Naive mean of 8 and 6 is 7; weighted by counts (10 vs 2) it is ~7.67.
    const result = weightedThemeAvg([
      { avgOverallGrade: 8, evaluationCount: 10 },
      { avgOverallGrade: 6, evaluationCount: 2 },
    ]);
    expect(result).toBe(7.67);
  });

  it('rounds to 2 decimals (round-half-up, like legacy)', () => {
    const result = weightedThemeAvg([{ avgOverallGrade: 7.005, evaluationCount: 1 }]);
    expect(result).toBe(7.01);
  });

  it('returns null when there are zero contributing evaluations', () => {
    expect(weightedThemeAvg([])).toBeNull();
    expect(weightedThemeAvg([{ avgOverallGrade: 9, evaluationCount: 0 }])).toBeNull();
  });

  it('excludes rows with a null or NaN grade', () => {
    const result = weightedThemeAvg([
      { avgOverallGrade: null, evaluationCount: 5 },
      { avgOverallGrade: Number.NaN, evaluationCount: 5 },
      { avgOverallGrade: 8, evaluationCount: 4 },
    ]);
    expect(result).toBe(8);
  });
});

describe('trainerOverallAvg', () => {
  it('weights theme stats by their evaluation counts', () => {
    const result = trainerOverallAvg([
      { weightedAvg: 8, totalEvaluations: 3 },
      { weightedAvg: 6, totalEvaluations: 1 },
    ]);
    // (8*3 + 6*1) / 4 = 30 / 4 = 7.5
    expect(result).toBe(7.5);
  });

  it('returns 0 (not null) when there are no evaluations — legacy asymmetry', () => {
    expect(trainerOverallAvg([])).toBe(0);
    expect(trainerOverallAvg([{ weightedAvg: null, totalEvaluations: 0 }])).toBe(0);
  });

  it('skips NaN theme stats instead of poisoning the average', () => {
    const result = trainerOverallAvg([
      { weightedAvg: Number.NaN, totalEvaluations: 5 },
      { weightedAvg: 8, totalEvaluations: 2 },
    ]);
    expect(result).toBe(8);
  });

  it('keeps full precision (no premature rounding)', () => {
    const result = trainerOverallAvg([
      { weightedAvg: 7, totalEvaluations: 1 },
      { weightedAvg: 8, totalEvaluations: 2 },
    ]);
    // (7 + 16) / 3 = 23/3 = 7.666...
    expect(result).toBeCloseTo(7.6667, 4);
  });
});
