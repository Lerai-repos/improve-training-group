import { describe, expect, it } from 'vitest';

import {
  addLevel,
  defaultDirection,
  labelOf,
  levelOf,
  maxTheme,
  moveLevel,
  removeLevel,
  setDirection,
  sortColumnsFor,
  sortRows,
  themeBreakdown,
  travelMarginCents,
} from '../sorting';
import { row } from './fakes';

import type { SortLevel } from '../sorting';

/**
 * The panel's operations. Priority is explicit and reorderable — "most important first" —
 * rather than implied by the order someone clicked headers in.
 */
describe('building the sort chain', () => {
  it('adds a column at the END, the least important position', () => {
    let sort = addLevel([], 'totalCostCents');
    sort = addLevel(sort, 'grade');

    expect(sort).toEqual([
      { key: 'totalCostCents', direction: 'asc' },
      { key: 'grade', direction: 'desc' },
    ]);
  });

  it('never adds the same column twice', () => {
    const sort = addLevel(addLevel([], 'grade'), 'grade');
    expect(sort).toHaveLength(1);
  });

  /**
   * "Good" points in different directions per column, so the default has to as well.
   * A blanket `laag → hoog` would make "sort by cijfer" show the worst trainer first,
   * which is never what anyone means by it.
   */
  it('starts each column at its useful end', () => {
    // Less is better.
    for (const key of [
      'totalCostCents',
      'hourlyRateCents',
      'trainerTravelCostCents',
      'roundTripDurationMinutes',
    ] as const) {
      expect(defaultDirection(key)).toBe('asc');
    }
    // More is better.
    for (const key of ['grade', 'themeAvgScore', 'timesTaught', 'travelMarginCents'] as const) {
      expect(defaultDirection(key)).toBe('desc');
    }
    // Workload exists to spread work, so the useful end is the trainer with room.
    expect(defaultDirection('assignmentsThisMonth')).toBe('asc');
    expect(defaultDirection('assignmentsThisYear')).toBe('asc');
  });

  it('flips one level without touching the others', () => {
    const sort = setDirection(
      [
        { key: 'totalCostCents', direction: 'asc' },
        { key: 'grade', direction: 'asc' },
      ],
      'grade',
      'desc'
    );

    expect(sort).toEqual([
      { key: 'totalCostCents', direction: 'asc' },
      { key: 'grade', direction: 'desc' },
    ]);
  });

  it('removes a level', () => {
    expect(removeLevel([{ key: 'grade', direction: 'asc' }], 'grade')).toEqual([]);
  });

  /** Reordering must keep the direction — deleting and re-adding would lose it. */
  it('moves a level through the priority order, direction intact', () => {
    const sort = [
      { key: 'totalCostCents', direction: 'asc' } as const,
      { key: 'grade', direction: 'desc' } as const,
    ];

    expect(moveLevel(sort, 'grade', -1)).toEqual([
      { key: 'grade', direction: 'desc' },
      { key: 'totalCostCents', direction: 'asc' },
    ]);
  });

  it('will not move a level off either end', () => {
    const sort = [{ key: 'grade', direction: 'asc' } as const];
    expect(moveLevel(sort, 'grade', -1)).toEqual(sort);
    expect(moveLevel(sort, 'grade', 1)).toEqual(sort);
  });

  /** No cap: the team is used to as many levels as they like, and there is no principled
   *  place to stop them. */
  it('accepts as many levels as the planner wants', () => {
    let sort: ReturnType<typeof addLevel> = [];
    for (const column of sortColumnsFor(true)) {
      sort = addLevel(sort, column.key);
    }
    expect(sort.length).toBe(sortColumnsFor(true).length);
    expect(sort.length).toBeGreaterThan(10);
  });

  /** A restricted caller has neither the money nor the score columns to sort on. */
  it('offers a restricted caller only the columns they can see', () => {
    expect(sortColumnsFor(false).map((c) => c.key)).toEqual(['roundTripDurationMinutes']);
  });

  /**
   * Alphabetical order answers no question a planner has — they choose on cost, distance,
   * grade or workload, never on where a name falls in the alphabet. It was in the legacy
   * list; keeping it would be copying a column rather than a use.
   */
  it('does not offer the trainer name as a sort', () => {
    expect(sortColumnsFor(true).map((c) => c.label)).not.toContain('Trainer');
  });

  it('labels columns as the table heads them', () => {
    expect(labelOf('assignmentsThisMonth')).toBe('Opdrachten deze maand');
    expect(labelOf('travelMarginCents')).toBe('Reismarge');
  });

  it('reports a column’s position for the header to show', () => {
    const sort = addLevel(addLevel([], 'grade'), 'totalCostCents');
    expect(levelOf(sort, 'grade')).toBe(1);
    expect(levelOf(sort, 'totalCostCents')).toBe(2);
    expect(levelOf(sort, 'timesTaught')).toBeNull();
  });

  /**
   * Not offered as a column: an empty chain already falls back to it, so the engine's
   * order is where the list starts and where Reset returns to.
   */
  it('does not offer the recommended order as a column', () => {
    expect(sortColumnsFor(true).map((c) => c.label)).not.toContain('Aanbevolen volgorde');
  });
});

describe('sortRows', () => {
  const rows = [
    row({ trainerItemId: 'a', rank: 3, totalCostCents: 40_000, overallAverageDisplay: 7.0, roundTripDurationMinutes: 10 }),
    row({ trainerItemId: 'b', rank: 1, totalCostCents: 30_000, overallAverageDisplay: 9.0, roundTripDurationMinutes: 90 }),
    row({ trainerItemId: 'c', rank: 2, totalCostCents: 30_000, overallAverageDisplay: 6.0, roundTripDurationMinutes: 5 }),
  ];
  const order = (levels: SortLevel[]): string[] =>
    sortRows(rows, levels).map((r) => r.trainerItemId);

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

  /** No levels at all is the engine's own ranking. */
  it('returns the recommended order for an empty chain', () => {
    expect(order([])).toEqual(['b', 'c', 'a']);
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
   * A training can cover several themes, and the board deliberately stores one row per
   * (trainer, thema) — legacy's shape, and the only one both parity corpora can check.
   * The consequence is that a training covering two themes incremented BOTH rows, so
   * summing across them double-counts it.
   *
   * `max` is a lower bound and never overstates; `sum` is an upper bound and always may.
   * For the 98% of trainings with a single theme the two agree exactly.
   */
  describe('per-training counts across a multi-theme training', () => {
    const twoThemes = row({
      themes: [
        { themeItemId: 'a', qualification: 'green', average: 8, evaluationCount: 10, timesTaught: 5 },
        { themeItemId: 'b', qualification: 'green', average: 7, evaluationCount: 4, timesTaught: 2 },
      ],
    });

    it('shows the highest per-theme figure, not the total', () => {
      expect(maxTheme(twoThemes, 'timesTaught')).toBe(5);
      expect(maxTheme(twoThemes, 'evaluationCount')).toBe(10);
    });

    it('agrees with the single-theme case, where there is nothing to double-count', () => {
      const oneTheme = row({
        themes: [
          { themeItemId: 'a', qualification: 'green', average: 8, evaluationCount: 10, timesTaught: 5 },
        ],
      });

      expect(maxTheme(oneTheme, 'timesTaught')).toBe(5);
    });

    /** "No data" and "zero" stay different facts, exactly as before. */
    it('is null when no theme carries the figure at all', () => {
      const unknown = row({
        themes: [
          { themeItemId: 'a', qualification: 'green', average: null, evaluationCount: null, timesTaught: null },
        ],
      });

      expect(maxTheme(unknown, 'timesTaught')).toBeNull();
      expect(maxTheme(row({ themes: [] }), 'timesTaught')).toBeNull();
      expect(maxTheme(row({ themes: undefined }), 'timesTaught')).toBeNull();
    });

    it('ignores a theme with no figure rather than treating it as zero', () => {
      const mixed = row({
        themes: [
          { themeItemId: 'a', qualification: 'green', average: null, evaluationCount: null, timesTaught: null },
          { themeItemId: 'b', qualification: 'green', average: 7, evaluationCount: 4, timesTaught: 2 },
        ],
      });

      expect(maxTheme(mixed, 'timesTaught')).toBe(2);
    });

    it('keeps a genuine zero, which is not the same as no data', () => {
      const neverTaught = row({
        themes: [
          { themeItemId: 'a', qualification: 'green', average: null, evaluationCount: 0, timesTaught: 0 },
        ],
      });

      expect(maxTheme(neverTaught, 'timesTaught')).toBe(0);
    });

    it('offers the per-theme figures behind the maximum', () => {
      expect(themeBreakdown(twoThemes, 'timesTaught')).toBe('per thema: 5 · 2');
      expect(themeBreakdown(twoThemes, 'evaluationCount')).toBe('per thema: 10 · 4');
    });

    /**
     * Dropping nulls hides the tooltip on `[null, 5]` — two themes, one value — and with
     * more themes breaks the correspondence between the list and the theme order, so the
     * reader cannot tell which figure belongs where.
     */
    it('keeps a missing theme in place rather than dropping it', () => {
      const mixed = row({
        themes: [
          { themeItemId: 'a', qualification: 'green', average: null, evaluationCount: null, timesTaught: null },
          { themeItemId: 'b', qualification: 'green', average: 7, evaluationCount: 4, timesTaught: 5 },
        ],
      });

      expect(themeBreakdown(mixed, 'timesTaught')).toBe('per thema: — · 5');
      expect(maxTheme(mixed, 'timesTaught')).toBe(5);
    });

    /** A tooltip that merely repeats the cell is noise. */
    it('has nothing to add for a single theme, or for no data', () => {
      const one = row({
        themes: [
          { themeItemId: 'a', qualification: 'green', average: 8, evaluationCount: 10, timesTaught: 5 },
        ],
      });

      expect(themeBreakdown(one, 'timesTaught')).toBeNull();
      expect(themeBreakdown(row({ themes: [] }), 'timesTaught')).toBeNull();
      expect(themeBreakdown(row({ themes: undefined }), 'timesTaught')).toBeNull();
    });

    /**
     * The cell and the sort key MUST agree. A column showing `max` while the sort
     * compares `sum` is a bug nobody would ever find by looking at the screen.
     */
    it('sorts by the same figure the cell shows', () => {
      const high = row({
        trainerItemId: 'high',
        themes: [
          { themeItemId: 'a', qualification: 'green', average: 8, evaluationCount: 3, timesTaught: 9 },
        ],
      });
      const spread = row({
        trainerItemId: 'spread',
        themes: [
          { themeItemId: 'a', qualification: 'green', average: 8, evaluationCount: 3, timesTaught: 5 },
          { themeItemId: 'b', qualification: 'green', average: 8, evaluationCount: 3, timesTaught: 5 },
        ],
      });

      // Summing would put `spread` (10) above `high` (9); max keeps `high` on top.
      const sorted = sortRows([spread, high], [{ key: 'timesTaught', direction: 'desc' }]);
      expect(sorted.map((r) => r.trainerItemId)).toEqual(['high', 'spread']);
      expect(maxTheme(sorted[0], 'timesTaught')).toBe(9);
    });
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

  it('sorts by travel margin', () => {
    const margins = [
      row({ trainerItemId: 'a', rank: 1, clientTravelChargeCents: 1_000, trainerTravelCostCents: 900, travelTimeCompensationCents: 0 }),
      row({ trainerItemId: 'b', rank: 2, clientTravelChargeCents: 5_000, trainerTravelCostCents: 1_000, travelTimeCompensationCents: 0 }),
      row({ trainerItemId: 'c', rank: 3, clientTravelChargeCents: 900, trainerTravelCostCents: 1_000, travelTimeCompensationCents: 0 }),
    ];
    expect(
      sortRows(margins, [{ key: 'travelMarginCents', direction: 'desc' }]).map(
        (r) => r.trainerItemId
      )
    ).toEqual(['b', 'a', 'c']);
  });


  describe('trainers with no grades', () => {
    const withGap = [
      row({ trainerItemId: 'a', rank: 1, overallAverageDisplay: 7.0 }),
      row({ trainerItemId: 'b', rank: 2, overallAverageDisplay: null }),
      row({ trainerItemId: 'c', rank: 3, overallAverageDisplay: 9.0 }),
    ];
    const graded = (direction: 'asc' | 'desc'): string[] =>
      sortRows(withGap, [{ key: 'grade', direction }]).map((r) => r.trainerItemId);

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
    sortRows(rows, [{ key: 'grade', direction: 'desc' }]);
    expect(rows).toEqual(original);
  });
});
