import type { Cents, Qualification, Rankable } from '@lib/calc';
import type { EffectiveQualification } from '@lib/sync/artifact';

/**
 * Recommendation-engine domain types. Everything here is derived-from-raw and
 * pure — no I/O. The engine reads live Monday data + the coherent Supabase
 * snapshot, computes with the `lib/calc` layer, and ranks.
 */

export type { EffectiveQualification };

/** One live colour observation for a (trainer, theme) pair (from the Themas board). */
export interface QualObservation {
  trainerExternalId: string;
  themaExternalId: string;
  colour: Qualification;
}

/** The resolved effective qualification for a (trainer, theme) pair. */
export interface EffectiveQual {
  trainerExternalId: string;
  themaExternalId: string;
  observed: Qualification[];
  effective: EffectiveQualification | null;
  /** true when the pair was observed in more than one colour (conflict). */
  conflicted: boolean;
}

/** A candidate trainer, read live from the Monday trainers board. */
export interface CandidateTrainer {
  /**
   * The Monday item id — the trainer's STABLE DOMAIN IDENTITY, and the only one
   * there is: with no database there is no internal uuid. `RateCard.trainerId`
   * matches on this, so a trainer-scoped rate override is expressed against the
   * same id the board uses. Renaming a trainer is safe; deleting and recreating
   * them is not (a new item id orphans their history — see 08-valkuilen.md).
   */
  externalItemId: string;
  naam: string;
  adres: string | null;
  mondayGroup: string | null;
  rateKey: string | null;
}

/** One eval-snapshot row (from `trainings.*_snapshot`) for scoring. */
export interface TrainerThemeEval {
  trainerExternalId: string;
  themaExternalId: string;
  avgOverallGrade: number | null;
  evaluationCount: number;
}

/** Trainer scores for a training (both inert until M3 populates snapshots). */
export interface TrainerScores {
  themeAvgScore: number | null;
  overallAvgScore: number;
}

/** Round-trip travel for one trainer→training pairing (already doubled). */
export interface TrainerTravel {
  roundTripDistanceKm: number;
  hqRoundTripDistanceKm: number;
  roundTripDurationMinutes: number;
}

/** A fully-computed recommendation; satisfies {@link Rankable} for ranking. */
export interface ComputedRecommendation extends Rankable {
  billableHours: number;
  hourlyRateCents: Cents;
  trainingFeeCents: Cents;
  clientTravelChargeCents: Cents;
  travelTimeCompensationCents: Cents;
  roundTripDistanceKm: number;
  hqRoundTripDistanceKm: number;
  roundTripDurationMinutes: number;
  calculateTravel: boolean;
}

/** A ranked recommendation (1-based rank assigned after the deterministic sort). */
export interface RankedRecommendation extends ComputedRecommendation {
  rank: number;
}
