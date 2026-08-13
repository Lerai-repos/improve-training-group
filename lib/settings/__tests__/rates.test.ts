import { describe, expect, it } from 'vitest';

import { resolveHourlyRateCents } from '@lib/calc';

import { buildRateCards, REQUIRED_RATE_KEYS } from '../rates';

const both = new Map([
  ['2020-2024', 8800],
  ['2024-heden', 8400],
]);

describe('buildRateCards', () => {
  it('turns the two tariff rows into open-ended default cards', () => {
    const cards = buildRateCards(both);

    expect(cards).toHaveLength(2);
    expect(cards).toContainEqual({
      rateKey: '2020-2024',
      trainerId: null,
      validFrom: '2000-01-01',
      validUntil: null,
      hourlyRateCents: 8800,
    });
  });

  /**
   * `rates.ts` checks its own keys rather than trusting the app-key check to have
   * covered them — the two sets are validated in different places, and a row that falls
   * between them would resurrect the hardcoded €88 nobody can see.
   */
  it('throws when a tariff row is missing, naming it', () => {
    const onlyOne = new Map([['2020-2024', 8800]]);

    expect(() => buildRateCards(onlyOne)).toThrow(/2024-heden/);
    expect(() => buildRateCards(new Map())).toThrow();
  });

  it('lists exactly the two cohorts the engine can price', () => {
    expect([...REQUIRED_RATE_KEYS]).toEqual(['2020-2024', '2024-heden']);
  });

  /**
   * The cards are open-ended and resolution is by TRAINING date, which is what makes a
   * rate edit retroactive for anything recalculated afterwards. Pinned here so that
   * property is a decision rather than an accident.
   */
  it('prices any training date from a single open-ended card', () => {
    const cards = buildRateCards(both);

    expect(resolveHourlyRateCents(cards, '2020-2024', 'trainer-1', '2026-08-13')).toBe(8800);
    expect(resolveHourlyRateCents(cards, '2024-heden', 'trainer-1', '2021-01-01')).toBe(8400);
  });
});
