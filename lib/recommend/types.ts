import type { Cents, Qualification, Rankable } from '@lib/calc';
import type { EffectiveQualification } from '@lib/monday/qualification';
import type { RateOverride } from '@lib/trainers/uurtarief';

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
  /**
   * What this trainer's own `Uurtarief` cell says, if anything.
   *
   * Wins over {@link rateKey} when set, which is the whole point: ITG wanted the rate to
   * stop depending on which group somebody sits in. `'none'` is the common case and means
   * the cohort applies; `'invalid'` excludes this trainer rather than falling back, since
   * a typed-but-unreadable rate is a decision we failed to read, not an absent one.
   */
  rateOverride: RateOverride;
}

/** One eval-snapshot row (from `trainings.*_snapshot`) for scoring. */
export interface TrainerThemeEval {
  trainerExternalId: string;
  themaExternalId: string;
  avgOverallGrade: number | null;
  evaluationCount: number;
}

/**
 * One (trainer × thema) statistic as the engine consumes it.
 *
 * Extends {@link TrainerThemeEval} so `computeScores` takes it unchanged: the ranking
 * inputs and the display inputs are the SAME rows, read once. `timesTaught` is NOT added
 * to `TrainerThemeEval` itself — ranking never uses it (`lib/calc/rank.ts` sorts on cost,
 * theme average, overall average, travel), and putting it on the ranking input would
 * invite a future sort key to reach for it.
 */
export interface TrainerThemeStat extends TrainerThemeEval {
  /** Distinct completed trainings in which this trainer taught this theme. */
  timesTaught: number;
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
