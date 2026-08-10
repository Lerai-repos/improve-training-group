import { describe, expect, it } from 'vitest';

import { toStoredRows } from '../view-row';
import type { EffectiveQual, RankedRecommendation } from '../types';

const ranked = (externalItemId: string, rank: number): RankedRecommendation => ({
  externalItemId,
  rank,
  totalCostCents: 35_000,
  themeAvgScore: null,
  // The legacy Airtable formula returns 0, not null, for a trainer with no evaluations.
  overallAvgScore: 0,
  trainerTravelCostCents: 1_500,
  billableHours: 4,
  hourlyRateCents: 8_400,
  trainingFeeCents: 33_600,
  clientTravelChargeCents: 900,
  travelTimeCompensationCents: 0,
  roundTripDistanceKm: 40,
  hqRoundTripDistanceKm: 30,
  roundTripDurationMinutes: 52,
  calculateTravel: true,
});

const qual = (
  trainerExternalId: string,
  themaExternalId: string,
  effective: 'green' | 'red' | null
): EffectiveQual => ({
  trainerExternalId,
  themaExternalId,
  observed: [],
  effective,
  conflicted: false,
});

describe('toStoredRows', () => {
  /**
   * The whole point of storing ids instead of names: a breach of the key/value store
   * yields opaque Monday identifiers, the same discipline the travel cache follows by
   * keeping hashed address fingerprints rather than addresses.
   */
  it('stores no names — only ids and numbers', () => {
    const [row] = toStoredRows([ranked('t1', 1)], [qual('t1', 'th1', 'green')], ['th1']);
    const serialized = JSON.stringify(row);

    expect(serialized).not.toMatch(/[a-z]{3,}\s[A-Z]/); // no "Firstname Lastname" shapes
    expect(Object.keys(row)).not.toContain('name');
    expect(Object.keys(row)).not.toContain('trainerName');
    expect(row.trainerItemId).toBe('t1');
  });

  /**
   * `overallAvgScore` is 0 for a trainer with no evaluations. Rendering that scalar
   * would show a newly qualified trainer as the worst in the list — the "geen cijfers"
   * versus "slechte cijfers" confusion `02-datamodel-monday.md` calls the planner's
   * most-asked question. The display value must stay null instead.
   */
  it('keeps the ranking scalar and the display value apart', () => {
    const [row] = toStoredRows([ranked('t1', 1)], [], ['th1']);

    expect(row.overallAvgScore).toBe(0);
    expect(row.overallAverageDisplay).toBeNull();
    expect(row.overallEvaluationCount).toBeNull();
  });

  it('carries one entry per training theme, in the training’s order', () => {
    const [row] = toStoredRows(
      [ranked('t1', 1)],
      [qual('t1', 'th2', 'green'), qual('t1', 'th1', 'green')],
      ['th1', 'th2']
    );

    expect(row.themes.map((t) => t.themeItemId)).toEqual(['th1', 'th2']);
  });

  /**
   * A theme the trainer was never assessed on is null, not red. Treating absence as a
   * negative judgement is precisely the grijs bug that silently excluded three trainers
   * from ~95 themes each until 2026-08-04.
   */
  it('reports an unassessed theme as null rather than red', () => {
    const [row] = toStoredRows([ranked('t1', 1)], [qual('t1', 'th1', 'green')], ['th1', 'th2']);

    expect(row.themes[0].qualification).toBe('green');
    expect(row.themes[1].qualification).toBeNull();
  });

  it('does not leak one trainer’s qualifications onto another', () => {
    const rows = toStoredRows(
      [ranked('t1', 1), ranked('t2', 2)],
      [qual('t1', 'th1', 'green')],
      ['th1']
    );

    expect(rows[0].themes[0].qualification).toBe('green');
    expect(rows[1].themes[0].qualification).toBeNull();
  });

  it('leaves evaluation fields null while scores are inert — null, never 0', () => {
    const [row] = toStoredRows([ranked('t1', 1)], [qual('t1', 'th1', 'green')], ['th1']);

    expect(row.themes[0].average).toBeNull();
    expect(row.themes[0].evaluationCount).toBeNull();
    expect(row.themes[0].timesTaught).toBeNull();
  });

  it('preserves rank and the cost breakdown', () => {
    const rows = toStoredRows([ranked('t1', 1), ranked('t2', 2)], [], []);

    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[0].totalCostCents).toBe(35_000);
    expect(rows[0].trainingFeeCents).toBe(33_600);
    expect(rows[0].roundTripDurationMinutes).toBe(52);
  });

  it('returns an empty list for GEEN MATCH rather than throwing', () => {
    expect(toStoredRows([], [], ['th1'])).toEqual([]);
  });
});
