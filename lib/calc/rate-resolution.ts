import type { Cents } from './types';

/**
 * An effective-dated hourly rate. `trainerId === null` is a default card for the
 * whole `rateKey`; a non-null `trainerId` is a trainer-scoped override.
 * `validFrom` is inclusive, `validUntil` is exclusive (null = open-ended).
 * Dates are ISO `YYYY-MM-DD` so lexicographic comparison is chronological.
 */
export interface RateCard {
  rateKey: string;
  trainerId: string | null;
  validFrom: string;
  validUntil: string | null;
  hourlyRateCents: Cents;
}

function coversDate(card: RateCard, rateKey: string, date: string): boolean {
  return (
    card.rateKey === rateKey &&
    date >= card.validFrom &&
    (card.validUntil === null || date < card.validUntil)
  );
}

/**
 * Resolve a trainer's hourly rate for a training date:
 * 1. a matching trainer-scoped override wins;
 * 2. else the matching `rateKey` default;
 * 3. else throw — there is no silent fallback (a missing rate is a config error).
 */
export function resolveHourlyRateCents(
  cards: readonly RateCard[],
  rateKey: string,
  trainerId: string,
  date: string
): Cents {
  const override = cards.find((c) => c.trainerId === trainerId && coversDate(c, rateKey, date));
  if (override) {
    return override.hourlyRateCents;
  }

  const fallback = cards.find((c) => c.trainerId === null && coversDate(c, rateKey, date));
  if (fallback) {
    return fallback.hourlyRateCents;
  }

  throw new Error(`No rate_card for rateKey=${rateKey} trainer=${trainerId} date=${date}`);
}
