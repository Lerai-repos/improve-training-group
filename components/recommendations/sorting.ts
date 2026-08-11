import type { Row } from './types';

/**
 * Multi-level sorting, driven by an explicit Sort panel — the same shape as the Airtable
 * interface this replaces.
 *
 * A planner does not think "sort by cost", they think "cheapest, and among equals the
 * best-rated, and if that ties the nearest". With 24 trainers on one €84 rate that is not
 * a nicety: the whole list ties on price, so the second and third levels are what
 * actually order it.
 *
 * Building the chain by clicking headers could express that, but not legibly — the
 * priority was implicit in click order and invisible afterwards. The panel makes the
 * order explicit, reorderable, and as long as the planner wants.
 */

export type SortKey =
  | 'themeAvgScore'
  | 'grade'
  | 'themeEvalCount'
  | 'totalEvalCount'
  | 'timesTaught'
  | 'roundTripDurationMinutes'
  | 'hourlyRateCents'
  | 'trainerTravelCostCents'
  | 'travelMarginCents'
  | 'totalCostCents'
  | 'assignmentsThisMonth'
  | 'assignmentsThisYear';

export type SortDirection = 'asc' | 'desc';

export interface SortLevel {
  key: SortKey;
  direction: SortDirection;
}

/** Every sortable column, in the order the panel offers them. */
export interface SortColumn {
  key: SortKey;
  label: string;
  /**
   * Which end of this column a planner wants FIRST.
   *
   * Declared per column, not one blanket default, because "good" points in different
   * directions: cheapest cost, best grade, nearest travel, biggest margin, emptiest
   * diary. A single `laag → hoog` would make "sort by cijfer" show the worst trainer,
   * which is never what anyone means by it.
   */
  defaultDirection: SortDirection;
  /** Hidden from a restricted caller, who has neither the money nor the score columns. */
  fullOnly?: boolean;
}

export const SORT_COLUMNS: readonly SortColumn[] = [
  // Grades and experience: more is better.
  { key: 'themeAvgScore', label: 'Cijfer thema', defaultDirection: 'desc', fullOnly: true },
  { key: 'grade', label: 'Cijfer totaal', defaultDirection: 'desc', fullOnly: true },
  { key: 'themeEvalCount', label: 'Evals thema', defaultDirection: 'desc', fullOnly: true },
  { key: 'totalEvalCount', label: 'Evals totaal', defaultDirection: 'desc', fullOnly: true },
  { key: 'timesTaught', label: 'Keer gegeven', defaultDirection: 'desc', fullOnly: true },
  // Distance and money: less is better.
  { key: 'roundTripDurationMinutes', label: 'Reistijd (retour)', defaultDirection: 'asc' },
  { key: 'hourlyRateCents', label: 'Uurtarief', defaultDirection: 'asc', fullOnly: true },
  { key: 'trainerTravelCostCents', label: 'Reiskosten', defaultDirection: 'asc', fullOnly: true },
  // …except the margin, where a bigger number is the good end.
  { key: 'travelMarginCents', label: 'Reismarge', defaultDirection: 'desc', fullOnly: true },
  { key: 'totalCostCents', label: 'Totale kosten', defaultDirection: 'asc', fullOnly: true },
  /**
   * Workload low-first: the column exists to spread work, so the useful end is the
   * trainer with room. Sorting busiest-first would answer a question nobody is asking.
   */
  {
    key: 'assignmentsThisMonth',
    label: 'Opdrachten deze maand',
    defaultDirection: 'asc',
    fullOnly: true,
  },
  {
    key: 'assignmentsThisYear',
    label: 'Opdrachten dit jaar',
    defaultDirection: 'asc',
    fullOnly: true,
  },
];

export function sortColumnsFor(canViewFull: boolean): readonly SortColumn[] {
  return canViewFull ? SORT_COLUMNS : SORT_COLUMNS.filter((column) => column.fullOnly !== true);
}

export function labelOf(key: SortKey): string {
  return SORT_COLUMNS.find((column) => column.key === key)?.label ?? key;
}

/** The useful end of this column — see {@link SortColumn.defaultDirection}. */
export function defaultDirection(key: SortKey): SortDirection {
  return SORT_COLUMNS.find((column) => column.key === key)?.defaultDirection ?? 'asc';
}

/** Add a column to the end of the chain — the least important position. */
export function addLevel(levels: readonly SortLevel[], key: SortKey): SortLevel[] {
  if (levels.some((level) => level.key === key)) {
    return [...levels];
  }
  return [...levels, { key, direction: defaultDirection(key) }];
}

export function removeLevel(levels: readonly SortLevel[], key: SortKey): SortLevel[] {
  return levels.filter((level) => level.key !== key);
}

export function setDirection(
  levels: readonly SortLevel[],
  key: SortKey,
  direction: SortDirection
): SortLevel[] {
  return levels.map((level) => (level.key === key ? { ...level, direction } : level));
}

/**
 * Move a level up or down the priority order.
 *
 * Priority is the whole point of the panel — "most important first" — so it has to be
 * changeable without deleting and re-adding, which would lose the direction too.
 */
export function moveLevel(levels: readonly SortLevel[], key: SortKey, delta: number): SortLevel[] {
  const from = levels.findIndex((level) => level.key === key);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= levels.length) {
    return [...levels];
  }
  const next = [...levels];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Which level a column occupies, 1-based, or null when it is not part of the sort. */
export function levelOf(levels: readonly SortLevel[], key: SortKey): number | null {
  const index = levels.findIndex((level) => level.key === key);
  return index === -1 ? null : index + 1;
}

/**
 * Legacy Airtable's "Travel Profit Margin": what the client is charged for travel, minus
 * BOTH of what that travel costs us.
 *
 *     client charge − trainer travel cost − travel-time compensation
 *
 * Verified against all 607 records in `snapshots/airtable/aanbevelingen.json` — every one
 * matches. Omitting the compensation is the tempting version and it is wrong in the
 * flattering direction: on a long trip it overstates the margin by the entire
 * compensation, €97 on the first record alone, turning −€137.84 into −€40.84. A planner
 * choosing on this column would systematically pick the expensive option.
 *
 * Null when any part is missing, so a restricted row never reads as a €0 margin.
 */
export function travelMarginCents(row: Row): number | null {
  const { clientTravelChargeCents, trainerTravelCostCents, travelTimeCompensationCents } = row;
  if (
    clientTravelChargeCents === undefined ||
    trainerTravelCostCents === undefined ||
    travelTimeCompensationCents === undefined
  ) {
    return null;
  }
  return clientTravelChargeCents - trainerTravelCostCents - travelTimeCompensationCents;
}

/**
 * Totals across a training's themes. Null when NO theme has the figure — so "we have no
 * evaluation data" stays distinct from a genuine zero, which is the distinction the whole
 * display layer is built around.
 */
export function sumThemes(row: Row, field: 'evaluationCount' | 'timesTaught'): number | null {
  const values = (row.themes ?? []).map((theme) => theme[field]).filter((v) => v !== null);
  return values.length === 0 ? null : values.reduce((total, v) => total + (v ?? 0), 0);
}

/**
 * The comparable value, or `null` for "no data" — which is NOT a zero and must not sort
 * as one. A trainer without grades belongs at the bottom of a grade sort whichever way
 * it points, not at the top of a descending one.
 */
function valueOf(row: Row, key: SortKey): number | string | null {
  switch (key) {
    case 'themeAvgScore':
      return row.themeAvgScore ?? null;
    case 'grade':
      return row.overallAverageDisplay ?? null;
    case 'themeEvalCount':
      return sumThemes(row, 'evaluationCount');
    case 'totalEvalCount':
      return row.overallEvaluationCount ?? null;
    case 'timesTaught':
      return sumThemes(row, 'timesTaught');
    case 'travelMarginCents':
      return travelMarginCents(row);
    case 'assignmentsThisMonth':
      return row.assignmentsThisMonth ?? null;
    case 'assignmentsThisYear':
      return row.assignmentsThisYear ?? null;
    case 'roundTripDurationMinutes':
      return row.roundTripDurationMinutes;
    case 'hourlyRateCents':
      return row.hourlyRateCents ?? null;
    case 'trainerTravelCostCents':
      return row.trainerTravelCostCents ?? null;
    case 'totalCostCents':
      return row.totalCostCents ?? null;
  }
  /**
   * No `default`, deliberately.
   *
   * A fallback here would compile for a sort key nobody mapped and silently sort by
   * whatever it returned — the phase-3 columns are exactly the case: adding one and
   * forgetting this switch would produce an order that looks plausible and is arbitrary.
   * Exhaustive means TypeScript refuses the build instead.
   */
}

/**
 * No "Aanbevolen volgorde" column, deliberately.
 *
 * An empty chain already falls back to `rank` below, so the engine's own order is what
 * the list arrives in and what Reset returns to. Offering it as a selectable column would
 * be a second way to say the same thing — and a confusing one, since picking it as level
 * 3 would do nothing that the fallback was not already doing.
 */

/**
 * Trainer name is deliberately NOT sortable.
 *
 * Alphabetical order answers no question a planner has: they are choosing on cost,
 * distance, grade or workload, and never on where a name falls in the alphabet. It was in
 * the legacy list, and leaving it in would be copying a column rather than a use.
 */
function compareLevel(a: Row, b: Row, level: SortLevel): number {
  const left = valueOf(a, level.key);
  const right = valueOf(b, level.key);

  // Missing data sinks in BOTH directions, so flipping a grade sort never promotes the
  // trainers nobody has rated.
  if (left === null && right === null) {
    return 0;
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }

  const order = Number(left) - Number(right);
  return level.direction === 'asc' ? order : -order;
}

export function sortRows(rows: readonly Row[], levels: readonly SortLevel[]): Row[] {
  return [...rows].sort((a, b) => {
    for (const level of levels) {
      const order = compareLevel(a, b, level);
      if (order !== 0) {
        return order;
      }
    }
    // Rank is the final tiebreak, so the order is total and never shuffles between
    // renders of the same data.
    return a.rank - b.rank;
  });
}
