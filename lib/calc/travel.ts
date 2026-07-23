import type { Cents } from './types';

const MINUTES_PER_HOUR = 60;

/**
 * Trainer travel payout: `roundTripDistanceKm × ratePerKmCents`, rounded to cents.
 * Legacy: `roundTripKm * trainerRate` (flow-6:675). Rate €0.23/km → 23 cents/km.
 */
export function trainerTravelCost(roundTripDistanceKm: number, ratePerKmCents: Cents): Cents {
  return Math.round(roundTripDistanceKm * ratePerKmCents);
}

/**
 * Client travel charge: `hqRoundTripDistanceKm × ratePerKmCents`, rounded to cents.
 * Legacy: `hqRoundTripKm * clientRate` (flow-6:676). Rate €0.45/km → 45 cents/km.
 * This is the client-side charge and is NOT part of the trainer's total cost.
 */
export function clientTravelCharge(hqRoundTripDistanceKm: number, ratePerKmCents: Cents): Cents {
  return Math.round(hqRoundTripDistanceKm * ratePerKmCents);
}

/**
 * Travel-time compensation config.
 *
 * `mode` is intentionally config-driven because the formula is an OPEN question:
 * fase-1 code used `per_minute` (€1/min); the scoping doc says `hourly_rate`.
 * Building both lets us switch once the client confirms, without a code change.
 */
export interface TravelTimeConfig {
  thresholdMinutes: number;
  mode: 'per_minute' | 'hourly_rate';
  feePerMinuteCents: Cents;
  hourlyRateCents?: Cents;
}

/**
 * Travel-time compensation for minutes beyond the threshold.
 * Legacy: `max(0, roundTripMinutes - threshold) * feePerMinute` (flow-6:677),
 * i.e. the `per_minute` mode. Never negative.
 */
export function travelTimeCompensation(
  roundTripDurationMinutes: number,
  cfg: TravelTimeConfig
): Cents {
  const minutesOver = Math.max(0, roundTripDurationMinutes - cfg.thresholdMinutes);

  if (cfg.mode === 'hourly_rate') {
    if (cfg.hourlyRateCents === undefined) {
      throw new Error('travelTimeCompensation: hourly_rate mode requires hourlyRateCents');
    }
    return Math.round((minutesOver / MINUTES_PER_HOUR) * cfg.hourlyRateCents);
  }

  return Math.round(minutesOver * cfg.feePerMinuteCents);
}
