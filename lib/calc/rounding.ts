/**
 * Rounding helpers, matched to the legacy Airtable/n8n behavior.
 *
 * The legacy weighted-average stores `Math.round(x * 100) / 100` (flow-5:217),
 * i.e. round-half-up to 2 decimals. Reproduced exactly here so parity holds.
 */

const TWO_DECIMAL_FACTOR = 100;

/** Round-half-up to 2 decimals (matches legacy `Math.round(x * 100) / 100`). */
export function round2(value: number): number {
  return Math.round(value * TWO_DECIMAL_FACTOR) / TWO_DECIMAL_FACTOR;
}
