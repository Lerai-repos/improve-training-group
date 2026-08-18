import { describe, expect, it } from 'vitest';

import { NO_OVERRIDE, parseUurtarief } from '@lib/trainers/uurtarief';

import { trainerHourlyRateCents } from '../pricing';

import type { RateCard } from '@lib/calc';
import type { CandidateTrainer } from '../types';

const CARDS: RateCard[] = [
  {
    rateKey: '2020-2024',
    trainerId: null,
    validFrom: '2020-01-01',
    validUntil: null,
    hourlyRateCents: 8800,
  },
  {
    rateKey: '2024-heden',
    trainerId: null,
    validFrom: '2020-01-01',
    validUntil: null,
    hourlyRateCents: 8400,
  },
];

const trainer = (over: Partial<CandidateTrainer> = {}): CandidateTrainer => ({
  externalItemId: '1',
  naam: 'T1',
  adres: 'Straat 1',
  mondayGroup: 'topics',
  rateKey: '2020-2024',
  rateOverride: NO_OVERRIDE,
  ...over,
});

const ON = '2026-09-01';

describe('trainerHourlyRateCents', () => {
  it('falls back to the cohort when the column is empty', () => {
    expect(trainerHourlyRateCents(trainer(), CARDS, ON)).toBe(8800);
    expect(trainerHourlyRateCents(trainer({ rateKey: '2024-heden' }), CARDS, ON)).toBe(8400);
  });

  it('lets the trainer column win over the cohort', () => {
    const t = trainer({ rateOverride: parseUurtarief('125') });
    expect(trainerHourlyRateCents(t, CARDS, ON)).toBe(12500);
  });

  it('prices a trainer whose group carries no cohort at all', () => {
    // The whole point of the column: eligibility still gates on group, but a rate no
    // longer depends on which group somebody happens to sit in.
    const t = trainer({
      mondayGroup: 'group_mm0d6p4r',
      rateKey: null,
      rateOverride: parseUurtarief('90'),
    });
    expect(trainerHourlyRateCents(t, CARDS, ON)).toBe(9000);
  });

  it('excludes rather than silently falling back when the cell is unreadable', () => {
    // The trainer HAS a cohort, so a fallback would produce a confident 8800 built on a
    // value we failed to read. That is the answer nobody would ever question.
    const t = trainer({ rateOverride: parseUurtarief('500') });
    expect(t.rateOverride.kind).toBe('invalid');
    expect(trainerHourlyRateCents(t, CARDS, ON)).toBeNull();
  });

  it('returns null when there is neither an override nor a cohort', () => {
    expect(trainerHourlyRateCents(trainer({ rateKey: null }), CARDS, ON)).toBeNull();
  });

  it('returns null when no card covers the training date', () => {
    const expired: RateCard[] = [{ ...CARDS[0], validUntil: '2026-01-01' }];
    expect(trainerHourlyRateCents(trainer(), expired, ON)).toBeNull();
  });

  it('ignores the date entirely once an override is set', () => {
    // A flat column value has no validity window. Worth pinning: it means a cohort raise
    // on Instellingen does NOT reach a trainer who has their own rate.
    const t = trainer({ rateOverride: parseUurtarief('125') });
    expect(trainerHourlyRateCents(t, [], '1999-01-01')).toBe(12500);
  });

  it('still prefers a trainer-scoped rate card when there is no column value', () => {
    const cards: RateCard[] = [
      ...CARDS,
      {
        rateKey: '2020-2024',
        trainerId: '1',
        validFrom: '2020-01-01',
        validUntil: null,
        hourlyRateCents: 9900,
      },
    ];
    expect(trainerHourlyRateCents(trainer(), cards, ON)).toBe(9900);
  });
});
