import type { Cents } from './types';

/** The three trainer-side cost components that make up a recommendation's total. */
export interface TrainerCostComponents {
  trainingFeeCents: Cents;
  trainerTravelCostCents: Cents;
  travelTimeCompensationCents: Cents;
}

/** Training fee: `billableHours × hourlyRate`, rounded to cents. */
export function trainingFeeCents(billableHours: number, hourlyRateCents: Cents): Cents {
  return Math.round(billableHours * hourlyRateCents);
}

/**
 * Total (trainer) cost: `trainingFee + trainerTravelCost + travelTimeCompensation`.
 * Legacy: flow-6:678. The client travel charge is deliberately excluded — it is a
 * client-side figure, not part of what the trainer costs.
 */
export function totalCostCents(c: TrainerCostComponents): Cents {
  return c.trainingFeeCents + c.trainerTravelCostCents + c.travelTimeCompensationCents;
}
