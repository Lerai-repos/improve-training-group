import type { Cents } from './types';

/**
 * An effective-dated hourly rate. `trainerId === null` is a default card for the
 * whole `rateKey`; a non-null `trainerId` is a trainer-scoped override, keyed by
 * the trainer's MONDAY ITEM ID.
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
  const rate = tryResolveHourlyRateCents(cards, rateKey, trainerId, date);
  if (rate === null) {
    throw new Error(`No rate_card for rateKey=${rateKey} trainer=${trainerId} date=${date}`);
  }
  return rate;
}

/**
 * Same resolution order as {@link resolveHourlyRateCents} but returns null instead
 * of throwing, so a caller can *decide* what an unpriceable trainer means (the
 * recommendation engine excludes them as `no_rate` rather than failing the run).
 *
 * NOTE: `trainerId` is the MONDAY ITEM ID — the trainer's only identity now that
 * Monday is the source of truth. Both sides of this comparison must use the same
 * id space; a mismatch makes every override silently unmatchable, and the trainer
 * quietly falls back to the rateKey default or is excluded as `no_rate`.
 */
export function tryResolveHourlyRateCents(
  cards: readonly RateCard[],
  rateKey: string,
  trainerId: string,
  date: string
): Cents | null {
  const override = cards.find((c) => c.trainerId === trainerId && coversDate(c, rateKey, date));
  if (override) {
    return override.hourlyRateCents;
  }

  const fallback = cards.find((c) => c.trainerId === null && coversDate(c, rateKey, date));
  return fallback ? fallback.hourlyRateCents : null;
}
