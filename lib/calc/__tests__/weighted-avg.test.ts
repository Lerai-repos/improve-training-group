import { describe, expect, it } from 'vitest';

import { contributingEvaluations, trainerOverallAvg, weightedThemeAvg } from '../weighted-avg';

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

/**
 * The denominator behind `weightedThemeAvg`, exposed so no caller re-derives "which
 * rows counted". Drift here is invisible in the worst way: the average stays right
 * while the count beside it is inflated.
 */
describe('contributingEvaluations', () => {
  it('counts exactly the rows weightedThemeAvg used', () => {
    const evals = [
      { avgOverallGrade: 8, evaluationCount: 10 },
      { avgOverallGrade: 6, evaluationCount: 2 },
    ];

    expect(contributingEvaluations(evals)).toBe(12);
    // 8×10 + 6×2 = 92, and 92/12 = 7.67 — the same 12.
    expect(weightedThemeAvg(evals)).toBe(7.67);
  });

  it('excludes a training whose grade is null — it fed neither side of the fraction', () => {
    const evals = [
      { avgOverallGrade: null, evaluationCount: 5 },
      { avgOverallGrade: 8, evaluationCount: 4 },
    ];

    expect(contributingEvaluations(evals)).toBe(4);
    expect(weightedThemeAvg(evals)).toBe(8);
  });

  it('excludes NaN grades and non-positive counts', () => {
    expect(
      contributingEvaluations([
        { avgOverallGrade: Number.NaN, evaluationCount: 5 },
        { avgOverallGrade: 9, evaluationCount: 0 },
        { avgOverallGrade: 9, evaluationCount: -1 },
      ])
    ).toBe(0);
  });

  it('is 0 for an empty list, where the average is null', () => {
    expect(contributingEvaluations([])).toBe(0);
    expect(weightedThemeAvg([])).toBeNull();
  });

  /** The property the two functions must share, stated as a property. */
  it('is zero exactly when the average is null', () => {
    const cases: Array<Array<{ avgOverallGrade: number | null; evaluationCount: number }>> = [
      [],
      [{ avgOverallGrade: null, evaluationCount: 3 }],
      [{ avgOverallGrade: 7, evaluationCount: 0 }],
      [{ avgOverallGrade: 7, evaluationCount: 1 }],
      [
        { avgOverallGrade: null, evaluationCount: 9 },
        { avgOverallGrade: 7, evaluationCount: 1 },
      ],
    ];

    for (const evals of cases) {
      expect(contributingEvaluations(evals) === 0).toBe(weightedThemeAvg(evals) === null);
    }
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
