import type { RateCard } from '@lib/calc';

/**
 * The two `TARIEF …` rows → the engine's rate cards.
 *
 * This replaces `COHORT_RATE_CENTS` in `engine-config.ts`, which hardcoded €88 and €84
 * — the two most consequential numbers in the whole system, and the two the build spec
 * is most explicit about: *"Alle bedragen en drempels komen uit het Instellingen-board,
 * nooit uit de code."*
 *
 * ## Flat, not effective-dated
 *
 * `RateCard` supports `validFrom`/`validUntil`, and this deliberately does not use
 * them: ITG asked for it "like in Airtable", one row per cohort, edit the number. The
 * machinery stays in the type so dated rates can be exposed later without a migration.
 *
 * The consequence is worth stating to ITG rather than discovering: because
 * `resolveHourlyRateCents` picks by **training date** and these cards are open-ended,
 * editing a rate is **retroactive**. Trainings nobody recalculates keep the numbers
 * already stored with them; a June training recalculated in October prices at the new
 * rate.
 */

/** The cohorts `GROUP_POLICY` can assign. Both must be present — see below. */
export const REQUIRED_RATE_KEYS: readonly string[] = ['2020-2024', '2024-heden'];

/** Open-ended, matching what the `rate_cards` rows did before the database went away. */
const VALID_FROM = '2000-01-01';

/**
 * Build the default (non-trainer-scoped) cards.
 *
 * **Checks its own keys** rather than trusting `required.ts` to have covered them. The
 * app keys and the rate keys are validated in different places for different reasons,
 * and a row that fell between the two would leave the engine pricing from a hardcoded
 * default nobody can see on the board — the exact failure this module exists to end.
 */
export function buildRateCards(byRateKey: ReadonlyMap<string, number>): RateCard[] {
  const cards: RateCard[] = [];
  const missing: string[] = [];

  for (const rateKey of REQUIRED_RATE_KEYS) {
    const hourlyRateCents = byRateKey.get(rateKey);
    // Narrowed by the lookup itself, so there is no `?? 0` anywhere in this file. A
    // default of zero would be a FREE trainer — precisely the plausible-looking wrong
    // answer this module exists to make impossible.
    if (hourlyRateCents === undefined) {
      missing.push(rateKey);
      continue;
    }
    cards.push({ rateKey, trainerId: null, validFrom: VALID_FROM, validUntil: null, hourlyRateCents });
  }

  if (missing.length > 0) {
    throw new Error(
      `Instellingen-board mist het uurtarief voor: ${missing.join(', ')} — ` +
        'vul de TARIEF-rijen in; er is geen standaardtarief in de code'
    );
  }

  return cards;
}
