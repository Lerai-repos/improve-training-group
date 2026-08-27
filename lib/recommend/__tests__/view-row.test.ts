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
    const [row] = toStoredRows([ranked('t1', 1)], [qual('t1', 'th1', 'green')], ['th1'], null);
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
    const [row] = toStoredRows([ranked('t1', 1)], [], ['th1'], null);

    expect(row.overallAvgScore).toBe(0);
    expect(row.overallAverageDisplay).toBeNull();
    expect(row.overallEvaluationCount).toBeNull();
  });

  it('carries one entry per training theme, in the training’s order', () => {
    const [row] = toStoredRows(
      [ranked('t1', 1)],
      [qual('t1', 'th2', 'green'), qual('t1', 'th1', 'green')],
      ['th1', 'th2'],
      null
    );

    expect(row.themes.map((t) => t.themeItemId)).toEqual(['th1', 'th2']);
  });

  /**
   * A theme the trainer was never assessed on is null, not red. Treating absence as a
   * negative judgement is precisely the grijs bug that silently excluded three trainers
   * from ~95 themes each until 2026-08-04.
   */
  it('reports an unassessed theme as null rather than red', () => {
    const [row] = toStoredRows(
      [ranked('t1', 1)],
      [qual('t1', 'th1', 'green')],
      ['th1', 'th2'],
      null
    );

    expect(row.themes[0].qualification).toBe('green');
    expect(row.themes[1].qualification).toBeNull();
  });

  it('does not leak one trainer’s qualifications onto another', () => {
    const rows = toStoredRows(
      [ranked('t1', 1), ranked('t2', 2)],
      [qual('t1', 'th1', 'green')],
      ['th1'],
      null
    );

    expect(rows[0].themes[0].qualification).toBe('green');
    expect(rows[1].themes[0].qualification).toBeNull();
  });

  it('leaves evaluation fields null when the statistics were not consulted', () => {
    const [row] = toStoredRows([ranked('t1', 1)], [qual('t1', 'th1', 'green')], ['th1'], null);

    expect(row.themes[0].average).toBeNull();
    expect(row.themes[0].evaluationCount).toBeNull();
    expect(row.themes[0].timesTaught).toBeNull();
  });

  /**
   * The distinction the whole feature exists for (`02-datamodel-monday.md:121`).
   *
   * With statistics PRESENT, an absent pair is a fact: this trainer has never taught
   * this theme, so `0` is the honest answer and the screen can finally tell "groen maar
   * nooit gegeven" from "geen data". With statistics NOT consulted, the same absence
   * means nothing is known and must stay null, or the day the flag is off every trainer
   * is reported as having zero evaluations.
   */
  describe('consulted versus not consulted', () => {
    const stat = (thema: string, avg: number | null, count: number, taught: number) => ({
      trainerExternalId: 't1',
      themaExternalId: thema,
      avgOverallGrade: avg,
      evaluationCount: count,
      timesTaught: taught,
    });

    it('fills a pair the statistics know about', () => {
      const [row] = toStoredRows(
        [ranked('t1', 1)],
        [qual('t1', 'th1', 'green')],
        ['th1'],
        [stat('th1', 7.8, 12, 3)]
      );

      expect(row.themes[0]).toMatchObject({ average: 7.8, evaluationCount: 12, timesTaught: 3 });
    });

    it('reports a pair the statistics do NOT know about as zero, not unknown', () => {
      const [row] = toStoredRows(
        [ranked('t1', 1)],
        [qual('t1', 'th2', 'green')],
        ['th2'],
        [stat('th1', 7.8, 12, 3)]
      );

      expect(row.themes[0]).toMatchObject({ evaluationCount: 0, timesTaught: 0 });
      // No grades is still null — a zero average would read as a bad one.
      expect(row.themes[0].average).toBeNull();
    });

    it('reports the same pair as unknown when the statistics were not consulted', () => {
      const [row] = toStoredRows([ranked('t1', 1)], [qual('t1', 'th2', 'green')], ['th2'], null);

      expect(row.themes[0]).toMatchObject({
        average: null,
        evaluationCount: null,
        timesTaught: null,
      });
    });

    it('sums the trainer’s evaluations across every theme, not just the training’s', () => {
      const [row] = toStoredRows(
        [ranked('t1', 1)],
        [qual('t1', 'th1', 'green')],
        ['th1'],
        [stat('th1', 8, 10, 2), stat('th2', 6, 5, 1)]
      );

      expect(row.overallEvaluationCount).toBe(15);
    });

    /**
     * `overallAvgScore` is 0 for an unevaluated trainer — legacy's rule, right for
     * sorting. The display value must say "geen cijfers" instead, and must equal the
     * scalar the moment there is anything to show.
     */
    it('keeps the display average null at zero evaluations and equal to the scalar above it', () => {
      const [none] = toStoredRows([ranked('t1', 1)], [], ['th1'], []);
      expect(none.overallEvaluationCount).toBe(0);
      expect(none.overallAverageDisplay).toBeNull();
      expect(none.overallAvgScore).toBe(0);

      const [some] = toStoredRows([ranked('t1', 1)], [], ['th1'], [stat('th1', 8, 4, 1)]);
      expect(some.overallAverageDisplay).toBe(some.overallAvgScore);
    });

    it('does not leak one trainer’s statistics onto another', () => {
      const rows = toStoredRows(
        [ranked('t1', 1), ranked('t2', 2)],
        [],
        ['th1'],
        [stat('th1', 7.8, 12, 3)]
      );

      expect(rows[0].themes[0].evaluationCount).toBe(12);
      expect(rows[1].themes[0].evaluationCount).toBe(0);
      expect(rows[1].overallEvaluationCount).toBe(0);
    });
  });

  it('preserves rank and the cost breakdown', () => {
    const rows = toStoredRows([ranked('t1', 1), ranked('t2', 2)], [], [], null);

    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[0].totalCostCents).toBe(35_000);
    expect(rows[0].trainingFeeCents).toBe(33_600);
    expect(rows[0].roundTripDurationMinutes).toBe(52);
  });

  it('returns an empty list for GEEN MATCH rather than throwing', () => {
    expect(toStoredRows([], [], ['th1'], null)).toEqual([]);
  });
});
