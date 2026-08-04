import { describe, expect, it } from 'vitest';

import type { RateCard, TravelTimeConfig } from '@lib/calc';

import { priceTrainer, rankTrainers, type PricingContext } from '../pricing';
import type { CandidateTrainer, ComputedRecommendation, TrainerTravel } from '../types';

const CARD: RateCard = {
  rateKey: '2020-2024',
  trainerId: null,
  validFrom: '2000-01-01',
  validUntil: null,
  hourlyRateCents: 8800,
};
const TRAVEL_CFG: TravelTimeConfig = {
  thresholdMinutes: 90,
  mode: 'per_minute',
  feePerMinuteCents: 100,
};
const ctx: PricingContext = {
  trainingDate: '2026-02-10',
  duurTraining: 4,
  rateCards: [CARD],
  travelTimeConfig: TRAVEL_CFG,
  trainerTravelRateCentsPerKm: 23,
  clientTravelRateCentsPerKm: 45,
};
const trainer = (ext: string): CandidateTrainer => ({
  externalItemId: ext,
  naam: `T${ext}`,
  adres: 'A',
  mondayGroup: 'topics',
  rateKey: '2020-2024',
});
const roundTrip: TrainerTravel = {
  roundTripDistanceKm: 20,
  hqRoundTripDistanceKm: 24,
  roundTripDurationMinutes: 100,
};

describe('priceTrainer rate identity', () => {
  /**
   * With no database there is no internal uuid — the MONDAY ITEM ID is the trainer's
   * stable identity, so `rate_cards.trainerId` matches on it. Passing anything else
   * makes trainer-scoped overrides silently unmatchable, and the trainer falls back
   * to the rateKey default (or is excluded as `no_rate`) with no error.
   */
  it('resolves a trainer-scoped override on the Monday item id', () => {
    const MONDAY_ID = '1661151129';
    const override: RateCard = {
      rateKey: 'persoonlijk',
      trainerId: MONDAY_ID,
      validFrom: '2000-01-01',
      validUntil: null,
      hourlyRateCents: 9900,
    };
    const r = priceTrainer(
      { ...trainer(MONDAY_ID), rateKey: 'persoonlijk' },
      roundTrip,
      { themeAvgScore: null, overallAvgScore: 0 },
      { ...ctx, rateCards: [override] }
    );
    expect(r.hourlyRateCents).toBe(9900);
  });

  it('does not match an override belonging to a different trainer', () => {
    const override: RateCard = {
      rateKey: 'persoonlijk',
      trainerId: '9999999999',
      validFrom: '2000-01-01',
      validUntil: null,
      hourlyRateCents: 9900,
    };
    expect(() =>
      priceTrainer(
        { ...trainer('1661151129'), rateKey: 'persoonlijk' },
        roundTrip,
        { themeAvgScore: null, overallAvgScore: 0 },
        { ...ctx, rateCards: [override] }
      )
    ).toThrow(/No rate_card/);
  });
});

describe('priceTrainer', () => {
  it('total = fee + trainerTravel + timeComp; client charge excluded', () => {
    const r = priceTrainer(
      trainer('t1'),
      roundTrip,
      { themeAvgScore: null, overallAvgScore: 0 },
      ctx
    );
    expect(r.trainingFeeCents).toBe(35200); // 4h billable × 8800
    expect(r.trainerTravelCostCents).toBe(460); // 20km × 23
    expect(r.clientTravelChargeCents).toBe(1080); // 24km × 45 (NOT in total)
    expect(r.travelTimeCompensationCents).toBe(1000); // (100-90) × 100
    expect(r.totalCostCents).toBe(35200 + 460 + 1000);
    expect(r.calculateTravel).toBe(true);
  });

  it('no-travel (null) zeros every travel figure; total = fee only', () => {
    const r = priceTrainer(trainer('t1'), null, { themeAvgScore: null, overallAvgScore: 0 }, ctx);
    expect(r.trainerTravelCostCents).toBe(0);
    expect(r.clientTravelChargeCents).toBe(0);
    expect(r.travelTimeCompensationCents).toBe(0);
    expect(r.totalCostCents).toBe(35200);
    expect(r.calculateTravel).toBe(false);
  });

  it('throws when the trainer has no rate_key (no cohort)', () => {
    const noRate = { ...trainer('t1'), rateKey: null };
    expect(() =>
      priceTrainer(noRate, roundTrip, { themeAvgScore: null, overallAvgScore: 0 }, ctx)
    ).toThrow(/rate_key/);
  });
});

describe('rankTrainers', () => {
  const rec = (
    externalItemId: string,
    totalCostCents: number,
    trainerTravelCostCents: number
  ): ComputedRecommendation => ({
    externalItemId,
    totalCostCents,
    themeAvgScore: null,
    overallAvgScore: 0,
    trainerTravelCostCents,
    billableHours: 0,
    hourlyRateCents: 0,
    trainingFeeCents: 0,
    clientTravelChargeCents: 0,
    travelTimeCompensationCents: 0,
    roundTripDistanceKm: 0,
    hqRoundTripDistanceKm: 0,
    roundTripDurationMinutes: 0,
    calculateTravel: false,
  });

  it('sorts cost↑ then travel↑ (scores tie at null/0), assigning 1-based ranks', () => {
    const ranked = rankTrainers([rec('a', 1000, 500), rec('b', 1000, 300), rec('c', 900, 999)]);
    expect(ranked.map((r) => `${r.externalItemId}#${r.rank}`)).toEqual(['c#1', 'b#2', 'a#3']);
  });

  it('breaks exact ties by external item id', () => {
    const ranked = rankTrainers([rec('z', 1000, 100), rec('a', 1000, 100)]);
    expect(ranked.map((r) => r.externalItemId)).toEqual(['a', 'z']);
  });
});
