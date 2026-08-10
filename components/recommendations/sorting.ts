import type { Row } from './types';

/**
 * Multi-level sorting, built by clicking column headers.
 *
 * A planner does not think "sort by cost" — they think "cheapest, and among equals the
 * best-rated, and if that ties the nearest". Single-column sorting cannot express that,
 * and with 24 trainers on one €84 rate it matters: the whole list ties on price, so the
 * second and third levels are what actually order it.
 *
 * Clicking a header makes it the PRIMARY level and pushes what was there down, so
 * clicking price → score → travel reads exactly as it sounds. Clicking the current
 * primary again flips its direction instead of re-adding it.
 */

export type SortKey =
  | 'rank'
  | 'trainer'
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

/**
 * Three is the useful depth. Beyond it the levels stop being ones anybody chose on
 * purpose, and the header numbering turns into noise.
 */
export const MAX_SORT_LEVELS = 3;

/**
 * What a first click on each column should mean.
 *
 * Cheap-first and near-first are obvious; **grades are high-first**, because "sort by
 * cijfer" never means "show me the worst trainer". Getting this wrong is the kind of
 * thing people work around by clicking twice every time instead of reporting.
 */
const HIGH_FIRST: readonly SortKey[] = [
  'themeAvgScore',
  'grade',
  'themeEvalCount',
  'totalEvalCount',
  'timesTaught',
  'travelMarginCents',
];

export function defaultDirection(key: SortKey): SortDirection {
  return HIGH_FIRST.includes(key) ? 'desc' : 'asc';
}

/** Click a header: promote it to primary, or flip it if it already is. */
export function applySort(levels: readonly SortLevel[], key: SortKey): SortLevel[] {
  const [primary] = levels;
  if (primary?.key === key) {
    const flipped: SortLevel = {
      key,
      direction: primary.direction === 'asc' ? 'desc' : 'asc',
    };
    return [flipped, ...levels.slice(1)];
  }
  const rest = levels.filter((level) => level.key !== key);
  return [{ key, direction: defaultDirection(key) }, ...rest].slice(0, MAX_SORT_LEVELS);
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
    case 'trainer':
      return row.trainerItemId;
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
    default:
      return row.rank;
  }
}

function compareLevel(a: Row, b: Row, level: SortLevel, names: ReadonlyMap<string, string>): number {
  // Trainer sorts by the NAME on screen, not the id behind it — an id ordering would
  // look arbitrary to the only person who ever uses this column.
  if (level.key === 'trainer') {
    const left = names.get(a.trainerItemId) ?? `#${a.trainerItemId}`;
    const right = names.get(b.trainerItemId) ?? `#${b.trainerItemId}`;
    const order = left.localeCompare(right, 'nl');
    return level.direction === 'asc' ? order : -order;
  }

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

export function sortRows(
  rows: readonly Row[],
  levels: readonly SortLevel[],
  names: ReadonlyMap<string, string>
): Row[] {
  return [...rows].sort((a, b) => {
    for (const level of levels) {
      const order = compareLevel(a, b, level, names);
      if (order !== 0) {
        return order;
      }
    }
    // Rank is the final tiebreak, so the order is total and never shuffles between
    // renders of the same data.
    return a.rank - b.rank;
  });
}
