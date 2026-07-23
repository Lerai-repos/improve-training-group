import { describe, expect, it } from 'vitest';

import { resolveQualification } from '../qualification';

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
