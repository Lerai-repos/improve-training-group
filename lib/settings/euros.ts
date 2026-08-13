/**
 * Euro strings from the Instellingen board → integer cents.
 *
 * The board speaks euros because that is what ITG types and what Airtable's
 * `Configurarie` already holds (`0.23`, not `23`). Asking anyone to enter a price in
 * cents is how a tenfold error gets in. The engine speaks cents because money in
 * floats is how a rounding error becomes a price. This module is the only crossing.
 *
 * ## Why it parses digits instead of multiplying
 *
 * The obvious implementation is `Math.round(Number(value) * 100)`, and it is wrong in
 * a way that shows up in real values rather than contrived ones:
 *
 *     Number('0.29') * 100  →  28.999999999999996
 *     Number('84.10') * 100 →  8409.999999999998
 *
 * `Math.round` papers over both, but it also papers over everything else — and it makes
 * `Number('1e3')` a perfectly acceptable €1000/km. So the value is validated as a plain
 * decimal first and then assembled from its digits, where no float ever appears.
 */

const CENTS_PER_EURO = 100;
const DECIMALS = 2;

/**
 * A plain decimal amount: digits, optionally one separator and one or two decimals.
 *
 * Deliberately strict about what it does NOT admit — a leading `+`/`-`, an exponent, a
 * thousands separator, a currency symbol, a trailing unit. Every one of those is either
 * a typo or a misunderstanding of the field, and both are better refused than rounded
 * into something plausible.
 */
const DECIMAL_AMOUNT = /^(\d+)(?:[.,](\d{1,2}))?$/;

export function eurosToCents(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === '') {
    // Blank is NOT zero. A cleared travel rate must not quietly mean "travel is free";
    // the config layer applies the same rule to every numeric key, for the same reason.
    throw new Error('Bedrag is leeg — vul een bedrag in euro in, bijvoorbeeld 0.23');
  }

  const match = DECIMAL_AMOUNT.exec(trimmed);
  if (match === null) {
    throw new Error(
      `Ongeldig bedrag "${raw}" — verwacht een bedrag in euro, bijvoorbeeld 0.23 of 88`
    );
  }

  const [, whole, fraction = ''] = match;
  // `padEnd`, not `padStart`: "0.5" is fifty cents, not five.
  const cents = fraction.padEnd(DECIMALS, '0');

  return Number(whole) * CENTS_PER_EURO + Number(cents);
}
