/**
 * Display helpers, in Dutch, for a Dutch planning team.
 *
 * The one rule worth stating: **absent is not zero**. A trainer with no evaluations has
 * `overallAverageDisplay === null`, and rendering that as `0,0` would put a brand-new
 * trainer at the bottom of a column the planner reads as quality. "Geen cijfers" is a
 * different statement from a bad grade, and the spec calls telling them apart the
 * planner's most-asked question.
 */

/**
 * Cents, shown to the cent.
 *
 * Whole euros read more cleanly in a dense table, but they hide the figure this table
 * exists to compare. Two candidates €0,40 apart both render as the same number, and the
 * damage is worst on **Reismarge**, where the values sit near zero: a displayed `€ -7`
 * is anything from −7,49 to −6,50, on a column planners sort by.
 *
 * It is also what these numbers looked like in Airtable — `Total Cost 509,87`, not
 * `€ 510` — so a planner reconciling the new screen against the old one, or against an
 * invoice, sees the same value rather than one that is nearly the same.
 */
const EUR = new Intl.NumberFormat('nl-NL', {
  style: 'currency',
  currency: 'EUR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const GRADE = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const HOURS = new Intl.NumberFormat('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const CENTS_PER_EURO = 100;
const MINUTES_PER_HOUR = 60;

/** An em dash, never `€ 0` — a missing figure and a free one are different facts. */
export function euros(cents: number | undefined): string {
  return cents === undefined ? '—' : EUR.format(cents / CENTS_PER_EURO);
}

export function grade(value: number | null | undefined): string {
  return value === null || value === undefined ? 'geen cijfers' : GRADE.format(value);
}

/**
 * Session length in hours, as Airtable's "Duur training" / "Duur facturatie" show it.
 *
 * Two decimals rather than the `1 u 25 m` shape below, because these are the board's own
 * numbers and planners reconcile them against Monday and the invoice by eye. Half-hours
 * are routine (3,5), so trailing precision is kept rather than rounded away.
 */
export function hours(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : HOURS.format(value);
}

/** Round-trip minutes as `1 u 25 m`; the raw number is rarely what a planner wants. */
export function duration(minutes: number): string {
  const whole = Math.round(minutes);
  const hours = Math.floor(whole / MINUTES_PER_HOUR);
  const rest = whole % MINUTES_PER_HOUR;
  return hours === 0 ? `${rest} m` : `${hours} u ${rest} m`;
}

export const FAILURE_STAGE_LABELS: Record<string, string> = {
  address: 'De locatie kon niet worden herkend.',
  travel: 'De reisafstand kon niet worden bepaald.',
  monday: 'Monday was niet bereikbaar.',
  invalid_date: 'De datum ontbreekt of is ongeldig.',
  invalid_duration: 'De exacte duur ontbreekt of is 0.',
  dlq_exhausted: 'De berekening is na meerdere pogingen opgegeven.',
};

export function failureMessage(stage: string): string {
  return FAILURE_STAGE_LABELS[stage] ?? `De berekening is gestopt bij: ${stage}.`;
}
