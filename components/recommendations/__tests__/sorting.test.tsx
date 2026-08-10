import { describe, expect, it } from 'vitest';

import {
  applySort,
  defaultDirection,
  levelOf,
  MAX_SORT_LEVELS,
  sortRows,
  travelMarginCents,
} from '../sorting';
import { row } from './fakes';

import type { SortLevel } from '../sorting';

const NAMES = new Map([
  ['a', 'Anna Bakker'],
  ['b', 'Bram de Vries'],
  ['c', 'Chris Jansen'],
]);

describe('applySort', () => {
  /**
   * The behaviour the planner asked for: click price, then score, then travel time, and
   * get exactly that ordering. Single-column sorting cannot express it — and with 24
   * trainers on one €84 rate the whole list ties on price, so the later levels are what
   * actually order it.
   */
  it('builds a chain, newest click first', () => {
    let sort: SortLevel[] = [];
    sort = applySort(sort, 'totalCostCents');
    sort = applySort(sort, 'grade');
    sort = applySort(sort, 'roundTripDurationMinutes');

    expect(sort.map((s) => s.key)).toEqual([
      'roundTripDurationMinutes',
      'grade',
      'totalCostCents',
    ]);
  });

  it('flips the primary instead of re-adding it', () => {
    const sort = applySort(applySort([], 'totalCostCents'), 'totalCostCents');

    expect(sort).toEqual([{ key: 'totalCostCents', direction: 'desc' }]);
  });

  it('promotes a column already lower in the chain rather than duplicating it', () => {
    let sort: SortLevel[] = [];
    sort = applySort(sort, 'grade');
    sort = applySort(sort, 'totalCostCents');
    sort = applySort(sort, 'grade');

    expect(sort.map((s) => s.key)).toEqual(['grade', 'totalCostCents']);
  });

  it('keeps the chain to a usable depth', () => {
    let sort: SortLevel[] = [];
    for (const key of [
      'rank',
      'grade',
      'totalCostCents',
      'roundTripDurationMinutes',
      'hourlyRateCents',
    ] as const) {
      sort = applySort(sort, key);
    }
    expect(sort).toHaveLength(MAX_SORT_LEVELS);
  });

  /** "Sort by cijfer" never means "show me the worst trainer first". */
  it('starts grades high-first and everything else low-first', () => {
    expect(defaultDirection('grade')).toBe('desc');
    expect(defaultDirection('totalCostCents')).toBe('asc');
    expect(defaultDirection('roundTripDurationMinutes')).toBe('asc');
  });

  it('reports a column’s position for the header to show', () => {
    const sort = applySort(applySort([], 'grade'), 'totalCostCents');
    expect(levelOf(sort, 'totalCostCents')).toBe(1);
    expect(levelOf(sort, 'grade')).toBe(2);
    expect(levelOf(sort, 'rank')).toBeNull();
  });
});

describe('sortRows', () => {
  const rows = [
    row({ trainerItemId: 'a', rank: 3, totalCostCents: 40_000, overallAverageDisplay: 7.0, roundTripDurationMinutes: 10 }),
    row({ trainerItemId: 'b', rank: 1, totalCostCents: 30_000, overallAverageDisplay: 9.0, roundTripDurationMinutes: 90 }),
    row({ trainerItemId: 'c', rank: 2, totalCostCents: 30_000, overallAverageDisplay: 6.0, roundTripDurationMinutes: 5 }),
  ];
  const order = (levels: SortLevel[]): string[] =>
    sortRows(rows, levels, NAMES).map((r) => r.trainerItemId);

  it('sorts by one column', () => {
    expect(order([{ key: 'totalCostCents', direction: 'asc' }])).toEqual(['b', 'c', 'a']);
  });

  /** The point of the whole thing: b and c tie on price, the grade breaks it. */
  it('uses later levels to break ties in earlier ones', () => {
    expect(
      order([
        { key: 'totalCostCents', direction: 'asc' },
        { key: 'grade', direction: 'desc' },
      ])
    ).toEqual(['b', 'c', 'a']);

    expect(
      order([
        { key: 'totalCostCents', direction: 'asc' },
        { key: 'grade', direction: 'asc' },
      ])
    ).toEqual(['c', 'b', 'a']);
  });

  it('falls back to rank so the order never shuffles between renders', () => {
    expect(order([{ key: 'hourlyRateCents', direction: 'asc' }])).toEqual(['b', 'c', 'a']);
  });

  /**
   * The five columns that are empty until the Google Sheets join lands. They sort like
   * any other — and because "no data" sinks in both directions, a list where nobody has
   * been evaluated keeps its rank order instead of shuffling.
   */
  it('sorts the phase-3 columns, and leaves the order stable while they are empty', () => {
    for (const key of ['themeAvgScore', 'themeEvalCount', 'totalEvalCount', 'timesTaught'] as const) {
      expect(order([{ key, direction: 'desc' }])).toEqual(['b', 'c', 'a']);
    }
  });

  /**
   * The exact legacy formula, checked against a real Airtable record: client charge
   * €20.03 − trainer cost €60.87 − compensation €97.00 = −€137.84. Dropping the
   * compensation gives −€40.84, which is wrong in the direction that makes an expensive
   * trainer look affordable.
   */
  it('matches the legacy travel-margin formula, compensation included', () => {
    expect(
      travelMarginCents(
        row({
          clientTravelChargeCents: 2_003,
          trainerTravelCostCents: 6_087,
          travelTimeCompensationCents: 9_700,
        })
      )
    ).toBe(-13_784);
  });

  it('sorts by travel margin, highest first', () => {
    const margins = [
      row({ trainerItemId: 'a', rank: 1, clientTravelChargeCents: 1_000, trainerTravelCostCents: 900, travelTimeCompensationCents: 0 }),
      row({ trainerItemId: 'b', rank: 2, clientTravelChargeCents: 5_000, trainerTravelCostCents: 1_000, travelTimeCompensationCents: 0 }),
      row({ trainerItemId: 'c', rank: 3, clientTravelChargeCents: 900, trainerTravelCostCents: 1_000, travelTimeCompensationCents: 0 }),
    ];
    expect(
      sortRows(margins, [{ key: 'travelMarginCents', direction: 'desc' }], NAMES).map(
        (r) => r.trainerItemId
      )
    ).toEqual(['b', 'a', 'c']);
    expect(defaultDirection('travelMarginCents')).toBe('desc');
  });

  it('sorts trainers by the name on screen, not the id behind it', () => {
    expect(order([{ key: 'trainer', direction: 'asc' }])).toEqual(['a', 'b', 'c']);
    expect(order([{ key: 'trainer', direction: 'desc' }])).toEqual(['c', 'b', 'a']);
  });

  describe('trainers with no grades', () => {
    const withGap = [
      row({ trainerItemId: 'a', rank: 1, overallAverageDisplay: 7.0 }),
      row({ trainerItemId: 'b', rank: 2, overallAverageDisplay: null }),
      row({ trainerItemId: 'c', rank: 3, overallAverageDisplay: 9.0 }),
    ];
    const graded = (direction: 'asc' | 'desc'): string[] =>
      sortRows(withGap, [{ key: 'grade', direction }], NAMES).map((r) => r.trainerItemId);

    /**
     * "No grades" is unknown, not worst and not best. It sinks in BOTH directions, so
     * flipping the column never promotes the trainers nobody has rated to the top.
     */
    it('sinks in both directions rather than counting as a zero', () => {
      expect(graded('desc')).toEqual(['c', 'a', 'b']);
      expect(graded('asc')).toEqual(['a', 'c', 'b']);
    });
  });

  it('leaves the caller’s array untouched', () => {
    const original = [...rows];
    sortRows(rows, [{ key: 'grade', direction: 'desc' }], NAMES);
    expect(rows).toEqual(original);
  });
});
