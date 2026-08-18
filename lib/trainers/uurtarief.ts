/**
 * The `Uurtarief` column on the Trainers board → a per-trainer hourly rate, or a refusal.
 *
 * ITG asked for the rate to hang off a column instead of group membership, so they can
 * reorganise the groups without breaking pricing (Dirkje, 18-Aug-2026). This module is
 * the only place that turns what someone typed into money.
 *
 * ## Why an empty cell is not an error and a bad one is not a throw
 *
 * Empty is the normal state: 137 of 187 trainers sit in groups that carry no cohort at
 * all, and the ones that do fall back to the group rate from Instellingen. So a blank
 * means "use the cohort", nothing more.
 *
 * A cell that cannot be read is different, and it must not throw either. `toRoster` runs
 * once for the whole board, so one typo would take down every recommendation for every
 * training — the failure mode this codebase keeps designing away from. It also must not
 * quietly fall back to the cohort rate: someone who typed a number meant it, and pricing
 * them at €84 anyway is exactly the plausible-but-wrong answer that never gets noticed.
 * So an unreadable cell excludes THAT trainer, loudly and alone.
 */

import { eurosToCents } from '@lib/settings/euros';

import type { Cents } from '@lib/calc';

/**
 * Plausible bounds for an HOURLY rate, in euros.
 *
 * These exist for one specific mistake. The board already carries a trainer whose rate is
 * recorded as "500 euro per dagdeel trainer, 400 dagdeel acteur", and a dagdeel figure
 * typed into an hourly column is arithmetically perfect and about six times too high — it
 * would rank that trainer last and quote the client a number nobody would question until
 * it was invoiced. The cohort rates are €84 and €88, so the window is generous in both
 * directions while still refusing a dagdeel.
 */
export const MIN_HOURLY_EUROS = 20;
export const MAX_HOURLY_EUROS = 250;

const CENTS_PER_EURO = 100;

/**
 * What the column says about one trainer.
 *
 * A discriminated union rather than `number | null`, because "nothing typed" and "typed
 * something unusable" need opposite handling and a null cannot tell them apart.
 */
export type RateOverride =
  /** No value: the trainer's group rate applies. */
  | { readonly kind: 'none' }
  /** A usable hourly rate for this trainer specifically. */
  | { readonly kind: 'cents'; readonly cents: Cents }
  /** Present but unusable. The trainer is excluded, with this reason for the operator. */
  | { readonly kind: 'invalid'; readonly raw: string; readonly reason: string };

export const NO_OVERRIDE: RateOverride = { kind: 'none' };

/**
 * Read one `Uurtarief` cell.
 *
 * Takes the rendered `text` of the Monday numbers column, which is what the reader
 * already projects. Never throws.
 */
export function parseUurtarief(raw: string | null | undefined): RateOverride {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return NO_OVERRIDE;
  }

  let cents: number;
  try {
    cents = eurosToCents(raw);
  } catch (error) {
    return {
      kind: 'invalid',
      raw,
      reason: error instanceof Error ? error.message : 'onleesbaar bedrag',
    };
  }

  if (cents < MIN_HOURLY_EUROS * CENTS_PER_EURO || cents > MAX_HOURLY_EUROS * CENTS_PER_EURO) {
    return {
      kind: 'invalid',
      raw,
      reason:
        `${raw} valt buiten €${MIN_HOURLY_EUROS}–€${MAX_HOURLY_EUROS} per uur. ` +
        'Let op: deze kolom is een UURtarief, geen dagdeeltarief.',
    };
  }

  return { kind: 'cents', cents };
}

/**
 * Cents → the euro string written into the column, the exact inverse of the parser.
 *
 * Assembled from digits for the same reason `eurosToCents` takes them apart: `8409 / 100`
 * is `84.09` today and a float either way, and this value is written to a board where a
 * human will read it. Whole amounts lose the `,00` because that is how ITG types them.
 */
export function centsToEuros(cents: Cents): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`centsToEuros: ${cents} is geen geheel aantal centen`);
  }
  const whole = Math.floor(cents / CENTS_PER_EURO);
  const fraction = cents % CENTS_PER_EURO;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, '0')}`;
}
