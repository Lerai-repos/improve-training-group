import { describe, expect, it } from 'vitest';

import { resolveHourlyRateCents, type RateCard } from '../rate-resolution';

const cards: RateCard[] = [
  {
    rateKey: '2020-2024',
    trainerId: null,
    validFrom: '2020-01-01',
    validUntil: '2024-01-01',
    hourlyRateCents: 8800,
  },
  {
    rateKey: '2024-heden',
    trainerId: null,
    validFrom: '2024-01-01',
    validUntil: null,
    hourlyRateCents: 8400,
  },
  {
    // trainer-scoped override for a specific person
    rateKey: '2024-heden',
    trainerId: 'trainer-1',
    validFrom: '2024-01-01',
    validUntil: null,
    hourlyRateCents: 9500,
  },
];

describe('resolveHourlyRateCents', () => {
  it('uses the matching rate_key default when there is no override', () => {
    expect(resolveHourlyRateCents(cards, '2024-heden', 'trainer-2', '2025-06-01')).toBe(8400);
  });

  it('prefers a trainer-scoped override over the default', () => {
    expect(resolveHourlyRateCents(cards, '2024-heden', 'trainer-1', '2025-06-01')).toBe(9500);
  });

  it('resolves by the training date across periods', () => {
    expect(resolveHourlyRateCents(cards, '2020-2024', 'trainer-2', '2022-05-01')).toBe(8800);
  });

  it('treats valid_from as inclusive and valid_until as exclusive', () => {
    // 2024-01-01 is the exclusive end of the old period and inclusive start of the new
    expect(resolveHourlyRateCents(cards, '2024-heden', 'trainer-2', '2024-01-01')).toBe(8400);
    expect(() => resolveHourlyRateCents(cards, '2020-2024', 'trainer-2', '2024-01-01')).toThrow();
  });

  it('throws when no card covers the date (no silent fallback)', () => {
    expect(() => resolveHourlyRateCents(cards, '2020-2024', 'trainer-2', '2019-12-31')).toThrow();
  });
});
