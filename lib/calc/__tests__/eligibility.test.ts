import { describe, expect, it } from 'vitest';

import { countsForEvaluation } from '../eligibility';

describe('countsForEvaluation', () => {
  it('is true at or above the threshold (inclusive)', () => {
    expect(countsForEvaluation(4, 4)).toBe(true);
    expect(countsForEvaluation(5, 4)).toBe(true);
  });

  it('is false below the threshold', () => {
    expect(countsForEvaluation(3, 4)).toBe(false);
    expect(countsForEvaluation(0, 4)).toBe(false);
  });
});
