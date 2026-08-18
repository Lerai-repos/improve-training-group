import {
  billableHours,
  clientTravelCharge,
  rankRecommendations,
  totalCostCents,
  trainerTravelCost,
  trainingFeeCents,
  travelTimeCompensation,
  tryResolveHourlyRateCents,
  type Cents,
  type RateCard,
  type TravelTimeConfig,
} from '@lib/calc';

import type {
  CandidateTrainer,
  ComputedRecommendation,
  RankedRecommendation,
  TrainerScores,
  TrainerTravel,
} from './types';

/** Everything the pricing step needs beyond the per-trainer inputs. */
export interface PricingContext {
  /** Training date, ISO `YYYY-MM-DD` — the rate is resolved for this date. */
  trainingDate: string;
  /** Raw training duration in hours. */
  duurTraining: number;
  rateCards: readonly RateCard[];
  travelTimeConfig: TravelTimeConfig;
  trainerTravelRateCentsPerKm: Cents;
  clientTravelRateCentsPerKm: Cents;
}

const ZERO_TRAVEL: TrainerTravel = {
  roundTripDistanceKm: 0,
  hqRoundTripDistanceKm: 0,
  roundTripDurationMinutes: 0,
};

/**
 * What one trainer costs per hour on a given day, or null when they cannot be priced.
 *
 * The resolution order is the feature ITG asked for on 18-Aug-2026: the trainer's own
 * `Uurtarief` cell first, their group's cohort rate second. Both callers that need a rate
 * go through here — the eligibility filter in `service.ts` that drops unpriceable
 * trainers, and {@link priceTrainer} that bills them — so the two can never disagree
 * about who is priceable.
 *
 * Null means "excluded, with a reason", never "free". The three ways to get it:
 *   - an `Uurtarief` that was typed but is unreadable or implausible;
 *   - no override and a group with no cohort;
 *   - no override, a cohort, and no rate card covering that date.
 */
export function trainerHourlyRateCents(
  trainer: CandidateTrainer,
  rateCards: readonly RateCard[],
  trainingDate: string
): Cents | null {
  if (trainer.rateOverride.kind === 'cents') {
    return trainer.rateOverride.cents;
  }
  /**
   * An unreadable cell does NOT fall through to the cohort.
   *
   * Someone typed a number there and meant it. Quietly billing them at €84 instead
   * produces a plausible recommendation built on a value we failed to read, which is
   * precisely the class of error that never gets caught. Excluding them is visible.
   */
  if (trainer.rateOverride.kind === 'invalid') {
    return null;
  }
  if (trainer.rateKey === null) {
    return null;
  }
  return tryResolveHourlyRateCents(
    rateCards,
    trainer.rateKey,
    // The Monday item id — the trainer's only identity now that there is no
    // database. `RateCard.trainerId` is keyed on the same id.
    trainer.externalItemId,
    trainingDate
  );
}

/**
 * Price one eligible trainer into a {@link ComputedRecommendation}, wiring the
 * pure calc layer. `travel === null` means travel is deliberately unnecessary
 * (confirmed online) → every travel figure is 0. An unpriceable trainer throws,
 * surfacing as FOUT upstream — `service.ts` filters them out before this is reached.
 */
export function priceTrainer(
  trainer: CandidateTrainer,
  travel: TrainerTravel | null,
  scores: TrainerScores,
  ctx: PricingContext
): ComputedRecommendation {
  const hourlyRateCents = trainerHourlyRateCents(trainer, ctx.rateCards, ctx.trainingDate);
  if (hourlyRateCents === null) {
    throw new Error(
      `priceTrainer: trainer ${trainer.externalItemId} has no resolvable hourly rate ` +
        `(override=${trainer.rateOverride.kind}, rateKey=${trainer.rateKey ?? 'none'})`
    );
  }
  const t = travel ?? ZERO_TRAVEL;
  const billable = billableHours(ctx.duurTraining);
  const fee = trainingFeeCents(billable, hourlyRateCents);
  const trainerTravelCostCents = trainerTravelCost(
    t.roundTripDistanceKm,
    ctx.trainerTravelRateCentsPerKm
  );
  const clientTravelChargeCents = clientTravelCharge(
    t.hqRoundTripDistanceKm,
    ctx.clientTravelRateCentsPerKm
  );
  const travelTimeCompensationCents = travelTimeCompensation(
    t.roundTripDurationMinutes,
    ctx.travelTimeConfig
  );

  return {
    externalItemId: trainer.externalItemId,
    billableHours: billable,
    hourlyRateCents,
    trainingFeeCents: fee,
    trainerTravelCostCents,
    clientTravelChargeCents,
    travelTimeCompensationCents,
    totalCostCents: totalCostCents({
      trainingFeeCents: fee,
      trainerTravelCostCents,
      travelTimeCompensationCents,
    }),
    roundTripDistanceKm: t.roundTripDistanceKm,
    hqRoundTripDistanceKm: t.hqRoundTripDistanceKm,
    roundTripDurationMinutes: t.roundTripDurationMinutes,
    themeAvgScore: scores.themeAvgScore,
    overallAvgScore: scores.overallAvgScore,
    calculateTravel: travel !== null,
  };
}

/**
 * Apply the deterministic 5-layer ranking and assign a 1-based rank to each row.
 * Returns ALL trainers (no top-N cap), as the legacy engine does.
 */
export function rankTrainers(recs: readonly ComputedRecommendation[]): RankedRecommendation[] {
  return rankRecommendations(recs).map((rec, index) => ({ ...rec, rank: index + 1 }));
}
