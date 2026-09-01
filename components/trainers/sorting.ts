/**
 * Which rows the overview shows, and in what order.
 *
 * Pure and separate from the table so the two decisions that are easy to get wrong —
 * where an unevaluated trainer lands, and what happens to a trainer whose name Monday
 * did not return — can be pinned without rendering anything.
 */

import type { OverviewTrainerRow } from '@lib/evaluations';

export type SortKey = 'name' | 'score' | 'evaluations' | 'trainings' | 'themes';
export type SortDirection = 'asc' | 'desc';

export interface OverviewSort {
  readonly key: SortKey;
  readonly direction: SortDirection;
}

export interface OverviewFilters {
  /**
   * On by default in the view. Most of the roster has never been evaluated — 49 of 172
   * trainers had any evaluations in Airtable's own data — so without this the first
   * screen is mostly empty rows.
   */
  readonly onlyEvaluated: boolean;
  readonly search: string;
  /**
   * Trainers allowed by the group scope, or null for "no group restriction".
   *
   * A set of ids rather than group ids, because the board is the only thing that knows
   * who is in which group and it is read client-side. A trainer NOT in the set is
   * hidden — including one who has left the board entirely, which is the honest
   * reading of "show me these groups".
   */
  readonly allowedTrainerIds: ReadonlySet<string> | null;
}

export interface DisplayRow extends OverviewTrainerRow {
  /** The Monday name, or the id when the lookup came up short. */
  readonly label: string;
  /** True when we are showing an id because no name came back. */
  readonly unnamed: boolean;
}

/**
 * A trainer the statistics record says nothing about.
 *
 * Not an error and not rare: the nightly job writes a row only for a (trainer × thema)
 * pair with completed history or an assessed groen/oranje qualification, so anyone who
 * is only rood or grijs and has never taught a themed training is simply absent. They
 * belong in the table with empty figures — that is the honest answer, and it is what
 * makes switching the filter off mean something.
 */
function emptyRow(trainerExternalId: string): OverviewTrainerRow {
  return {
    trainerExternalId,
    overallAvg: null,
    evaluationCount: 0,
    themeCount: 0,
    trainingCount: null,
    themes: [],
  };
}

export function toDisplayRows(
  rows: readonly OverviewTrainerRow[],
  names: ReadonlyMap<string, string>,
  /**
   * Every trainer on the board, when the roster could be read. Trainers here but absent
   * from `rows` are added with empty figures; trainers in `rows` but not here are kept,
   * because a departed trainer's history is still history.
   */
  rosterIds: readonly string[] = []
): readonly DisplayRow[] {
  const known = new Set(rows.map((row) => row.trainerExternalId));
  const missing = rosterIds.filter((id) => !known.has(id)).map(emptyRow);

  return [...rows, ...missing].map((row) => {
    const name = names.get(row.trainerExternalId);
    return {
      ...row,
      label: name ?? `#${row.trainerExternalId}`,
      unnamed: name === undefined,
    };
  });
}

function value(row: DisplayRow, key: SortKey): number | null {
  switch (key) {
    case 'score':
      return row.overallAvg;
    case 'evaluations':
      return row.evaluationCount;
    case 'trainings':
      return row.trainingCount;
    case 'themes':
      return row.themeCount;
    case 'name':
      return null;
  }
}

/**
 * Missing values sink, in BOTH directions.
 *
 * A trainer with no score and a trainer with no training count are absences, not low
 * numbers. Sorting them as if they were zero would park everyone who has never been
 * evaluated at the top of "laagste cijfer eerst" — which reads as an answer to a
 * question nobody asked, and buries the trainers the sort was actually about.
 */
function compare(a: DisplayRow, b: DisplayRow, sort: OverviewSort): number {
  if (sort.key === 'name') {
    const byName = a.label.localeCompare(b.label, 'nl');
    return sort.direction === 'asc' ? byName : -byName;
  }

  const left = value(a, sort.key);
  const right = value(b, sort.key);
  if (left === null && right === null) {
    return a.label.localeCompare(b.label, 'nl');
  }
  if (left === null) {
    return 1;
  }
  if (right === null) {
    return -1;
  }
  if (left === right) {
    return a.label.localeCompare(b.label, 'nl');
  }
  return sort.direction === 'asc' ? left - right : right - left;
}

export function prepareRows(
  rows: readonly OverviewTrainerRow[],
  names: ReadonlyMap<string, string>,
  filters: OverviewFilters,
  sort: OverviewSort,
  rosterIds: readonly string[] = []
): readonly DisplayRow[] {
  const needle = filters.search.trim().toLowerCase();

  return toDisplayRows(rows, names, rosterIds)
    .filter((row) =>
      filters.allowedTrainerIds === null
        ? true
        : filters.allowedTrainerIds.has(row.trainerExternalId)
    )
    .filter((row) => (filters.onlyEvaluated ? row.evaluationCount > 0 : true))
    .filter((row) => (needle === '' ? true : row.label.toLowerCase().includes(needle)))
    .sort((a, b) => compare(a, b, sort));
}
