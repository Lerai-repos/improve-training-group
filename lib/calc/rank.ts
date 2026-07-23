import type { Cents } from './types';

/**
 * The fields the deterministic ranking sorts on. Recommendations carry more than
 * this, but ranking depends only on these.
 */
export interface Rankable {
  /** Stable Monday item id — the final tie-breaker (our addition; legacy has none). */
  externalItemId: string;
  totalCostCents: Cents;
  /** Trainer×theme weighted avg; null (no data) always sorts last. */
  themeAvgScore: number | null;
  overallAvgScore: number;
  trainerTravelCostCents: Cents;
}

function compareThemeAvgDesc(a: number | null, b: number | null): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return b - a;
}

/**
 * Deterministic recommendation ranking (does not mutate the input):
 * 1. Total cost ascending
 * 2. Theme average descending (null last)
 * 3. Overall average descending
 * 4. Trainer travel cost ascending
 * 5. External item id ascending — stable tie-breaker
 *
 * Order 1-4 matches the legacy 4-layer sort (PLAN-003:26). Layer 5 is our
 * addition to make exact ties deterministic (legacy leaves them arbitrary).
 */
export function rankRecommendations<T extends Rankable>(recs: readonly T[]): T[] {
  return [...recs].sort((a, b) => {
    if (a.totalCostCents !== b.totalCostCents) {
      return a.totalCostCents - b.totalCostCents;
    }
    const byTheme = compareThemeAvgDesc(a.themeAvgScore, b.themeAvgScore);
    if (byTheme !== 0) {
      return byTheme;
    }
    if (a.overallAvgScore !== b.overallAvgScore) {
      return b.overallAvgScore - a.overallAvgScore;
    }
    if (a.trainerTravelCostCents !== b.trainerTravelCostCents) {
      return a.trainerTravelCostCents - b.trainerTravelCostCents;
    }
    if (a.externalItemId < b.externalItemId) {
      return -1;
    }
    if (a.externalItemId > b.externalItemId) {
      return 1;
    }
    return 0;
  });
}
