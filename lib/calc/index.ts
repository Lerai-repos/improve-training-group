/**
 * The single calculation layer. Every derived figure in the system — billable
 * hours, weighted averages, travel cost/time, rate resolution, cost totals,
 * recommendation ranking — is computed here, from raw facts, by pure functions.
 * Nothing derived is ever stored.
 */
export type { Cents, Qualification, TravelMetrics } from './types';
export { round2 } from './rounding';
export { billableHours } from './billable-hours';
export { countsForEvaluation } from './eligibility';
export {
  weightedThemeAvg,
  trainerOverallAvg,
  type TrainingEval,
  type ThemeStat,
} from './weighted-avg';
export {
  trainerTravelCost,
  clientTravelCharge,
  travelTimeCompensation,
  type TravelTimeConfig,
} from './travel';
export {
  resolveHourlyRateCents,
  tryResolveHourlyRateCents,
  type RateCard,
} from './rate-resolution';
export { trainingFeeCents, totalCostCents, type TrainerCostComponents } from './cost';
export { rankRecommendations, type Rankable } from './rank';
export { resolveQualification } from './qualification';
