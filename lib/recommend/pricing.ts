import {
  billableHours,
  clientTravelCharge,
  rankRecommendations,
  resolveHourlyRateCents,
  totalCostCents,
  trainerTravelCost,
  trainingFeeCents,
  travelTimeCompensation,
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
 * Price one eligible trainer into a {@link ComputedRecommendation}, wiring the
 * pure calc layer. `travel === null` means travel is deliberately unnecessary
 * (confirmed online) → every travel figure is 0. A null `rateKey` (no cohort) has
 * no resolvable rate — `resolveHourlyRateCents` throws, surfacing as FOUT upstream.
 */
export function priceTrainer(
  trainer: CandidateTrainer,
  travel: TrainerTravel | null,
  scores: TrainerScores,
  ctx: PricingContext
): ComputedRecommendation {
  if (trainer.rateKey === null) {
    throw new Error(`priceTrainer: trainer ${trainer.externalItemId} has no rate_key (no cohort)`);
  }
  const t = travel ?? ZERO_TRAVEL;
  const billable = billableHours(ctx.duurTraining);
  const hourlyRateCents = resolveHourlyRateCents(
    ctx.rateCards,
    trainer.rateKey,
    // The Monday item id — the trainer's only identity now that there is no
    // database. `RateCard.trainerId` is keyed on the same id.
    trainer.externalItemId,
    ctx.trainingDate
  );
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
