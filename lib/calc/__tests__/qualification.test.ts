import { describe, expect, it } from 'vitest';

import { assessedColours, resolveQualification } from '../qualification';

describe('resolveQualification', () => {
  it('returns the single qualification when there is no conflict', () => {
    expect(resolveQualification(['oranje'])).toBe('oranje');
  });

  it('applies groen > oranje > rood > grijs precedence on conflict', () => {
    expect(resolveQualification(['rood', 'groen', 'grijs'])).toBe('groen');
    expect(resolveQualification(['grijs', 'oranje', 'rood'])).toBe('oranje');
    expect(resolveQualification(['grijs', 'rood'])).toBe('rood');
  });

  it('returns null when no qualification is given', () => {
    expect(resolveQualification([])).toBeNull();
  });
});

/**
 * `grijs` is the NOT-ASSESSED bucket, not a competing opinion. ITG's 30-July
 * groen/rood migration deliberately left trainers listed in grijs alongside their
 * new colour, so counting grijs as a conflicting assessment flags ~380 pairs and
 * silently drops those trainers from every recommendation.
 */
describe('assessedColours', () => {
  it('drops grijs so it never conflicts with a real assessment', () => {
    expect(assessedColours(['groen', 'grijs'])).toEqual(['groen']);
    expect(assessedColours(['rood', 'grijs'])).toEqual(['rood']);
  });

  it('returns empty when only grijs was observed (unassessed, not a conflict)', () => {
    expect(assessedColours(['grijs'])).toEqual([]);
    expect(assessedColours(['grijs', 'grijs'])).toEqual([]);
  });

  it('still surfaces a genuine contradiction between two real assessments', () => {
    expect(assessedColours(['groen', 'rood', 'grijs']).sort()).toEqual(['groen', 'rood']);
  });

  it('dedupes repeated colours', () => {
    expect(assessedColours(['groen', 'groen'])).toEqual(['groen']);
  });

  it('preserves a lone assessment untouched', () => {
    expect(assessedColours(['oranje'])).toEqual(['oranje']);
    expect(assessedColours([])).toEqual([]);
  });
});
