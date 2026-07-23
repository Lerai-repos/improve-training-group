/**
 * Shared calc-layer types.
 *
 * Money is carried as integer euro-cents end-to-end. Only convert to decimals
 * for display; never accumulate in floats.
 */

/** Money as integer euro-cents. */
export type Cents = number;

/** Trainer×theme qualification, worst-to-best precedence handled in mapping. */
export type Qualification = 'groen' | 'oranje' | 'rood' | 'grijs';

/**
 * Travel distances/times for one trainer→training pairing.
 * Distances/times are already ROUND-TRIP — the single one-way→round-trip
 * doubling happens once, in the I/O enrichment step, never in the calc layer.
 */
export interface TravelMetrics {
  roundTripDistanceKm: number;
  hqRoundTripDistanceKm: number;
  roundTripDurationMinutes: number;
}
