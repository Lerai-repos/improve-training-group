import { describe, expect, it } from 'vitest';

import { prepareRows, toDisplayRows } from '../sorting';

import type { OverviewTrainerRow } from '@lib/evaluations';
import type { OverviewFilters, OverviewSort } from '../sorting';

/**
 * NOTE: `.test.tsx`, not `.test.ts`, even though nothing here renders. The components
 * vitest project only picks up `.tsx` under `components/`, so a `.ts` file here would
 * exist, look tested, and never run.
 */

const trainer = (over: Partial<OverviewTrainerRow> = {}): OverviewTrainerRow => ({
  trainerExternalId: 't1',
  overallAvg: 8,
  evaluationCount: 4,
  themeCount: 2,
  trainingCount: 3,
  themes: [],
  ...over,
});

const names = new Map([
  ['t1', 'Anna Bakker'],
  ['t2', 'Bert de Vries'],
  ['t3', 'Carla Smit'],
]);

const filters = (over: Partial<OverviewFilters> = {}): OverviewFilters => ({
  onlyEvaluated: false,
  search: '',
  ...over,
});

const sort = (over: Partial<OverviewSort> = {}): OverviewSort => ({
  key: 'name',
  direction: 'asc',
  ...over,
});

describe('toDisplayRows', () => {
  it('uses the Monday name when there is one', () => {
    const [row] = toDisplayRows([trainer()], names);

    expect(row?.label).toBe('Anna Bakker');
    expect(row?.unnamed).toBe(false);
  });

  /**
   * Monday's `items(ids:)` can come back short, and a viewer may not be able to call the
   * API at all. Falling back to the id keeps the table correct and ranked; flagging it
   * is what stops a truncated response from looking like a trainer with no name.
   */
  it('falls back to the id and says so when no name came back', () => {
    const [row] = toDisplayRows([trainer({ trainerExternalId: 't9' })], names);

    expect(row?.label).toBe('#t9');
    expect(row?.unnamed).toBe(true);
  });
});

describe('prepareRows', () => {
  it('hides never-evaluated trainers when the filter is on', () => {
    const rows = prepareRows(
      [trainer(), trainer({ trainerExternalId: 't2', evaluationCount: 0, overallAvg: null })],
      names,
      filters({ onlyEvaluated: true }),
      sort()
    );

    expect(rows.map((r) => r.label)).toEqual(['Anna Bakker']);
  });

  it('searches on the resolved name, not the id', () => {
    const rows = prepareRows(
      [trainer(), trainer({ trainerExternalId: 't2' })],
      names,
      filters({ search: 'vries' }),
      sort()
    );

    expect(rows.map((r) => r.label)).toEqual(['Bert de Vries']);
  });

  it('sorts by name in Dutch collation', () => {
    const rows = prepareRows(
      [trainer({ trainerExternalId: 't3' }), trainer({ trainerExternalId: 't1' })],
      names,
      filters(),
      sort({ key: 'name', direction: 'asc' })
    );

    expect(rows.map((r) => r.label)).toEqual(['Anna Bakker', 'Carla Smit']);
  });

  /**
   * The one that matters. An absent score is not a low score: sorting it as zero would
   * fill the top of "laagste cijfer eerst" with everyone who has never been evaluated.
   */
  it('sinks a missing score in BOTH directions', () => {
    const rows = [
      trainer({ trainerExternalId: 't1', overallAvg: 8 }),
      trainer({ trainerExternalId: 't2', overallAvg: null, evaluationCount: 0 }),
      trainer({ trainerExternalId: 't3', overallAvg: 6 }),
    ];

    const desc = prepareRows(rows, names, filters(), sort({ key: 'score', direction: 'desc' }));
    const asc = prepareRows(rows, names, filters(), sort({ key: 'score', direction: 'asc' }));

    expect(desc.map((r) => r.label)).toEqual(['Anna Bakker', 'Carla Smit', 'Bert de Vries']);
    expect(asc.map((r) => r.label)).toEqual(['Carla Smit', 'Anna Bakker', 'Bert de Vries']);
  });

  it('sinks a missing training count the same way', () => {
    const rows = [
      trainer({ trainerExternalId: 't1', trainingCount: null }),
      trainer({ trainerExternalId: 't2', trainingCount: 2 }),
    ];

    const sorted = prepareRows(rows, names, filters(), sort({ key: 'trainings', direction: 'desc' }));

    expect(sorted.map((r) => r.label)).toEqual(['Bert de Vries', 'Anna Bakker']);
  });

  it('breaks ties by name so the order never wobbles between renders', () => {
    const rows = [
      trainer({ trainerExternalId: 't3', overallAvg: 8 }),
      trainer({ trainerExternalId: 't1', overallAvg: 8 }),
      trainer({ trainerExternalId: 't2', overallAvg: 8 }),
    ];

    const sorted = prepareRows(rows, names, filters(), sort({ key: 'score', direction: 'desc' }));

    expect(sorted.map((r) => r.label)).toEqual(['Anna Bakker', 'Bert de Vries', 'Carla Smit']);
  });
});

/**
 * Trainers the statistics say nothing about.
 *
 * The nightly job emits a row only for a (trainer × thema) pair with completed history
 * or an assessed groen/oranje qualification. A trainer who is only rood or grijs and has
 * never taught a themed training is therefore absent from the payload entirely — so
 * without the roster, switching "alleen trainers met evaluaties" off reveals nobody it
 * promised to.
 */
describe('the roster', () => {
  it('adds a trainer with no statistics at all', () => {
    const rows = prepareRows([trainer()], names, filters(), sort(), ['t1', 't2']);

    expect(rows.map((r) => r.label)).toEqual(['Anna Bakker', 'Bert de Vries']);
  });

  it('gives that trainer empty figures rather than zeroes', () => {
    const rows = prepareRows([trainer()], names, filters(), sort(), ['t1', 't2']);
    const added = rows.find((r) => r.trainerExternalId === 't2');

    expect(added?.overallAvg).toBeNull();
    expect(added?.trainingCount).toBeNull();
    expect(added?.themeCount).toBe(0);
    expect(added?.themes).toEqual([]);
  });

  it('hides them again when the filter is on', () => {
    const rows = prepareRows(
      [trainer()],
      names,
      filters({ onlyEvaluated: true }),
      sort(),
      ['t1', 't2']
    );

    expect(rows.map((r) => r.label)).toEqual(['Anna Bakker']);
  });

  /** A trainer who has left the board still has history worth showing. */
  it('keeps a trainer who has statistics but is no longer on the board', () => {
    const rows = prepareRows([trainer({ trainerExternalId: 't3' })], names, filters(), sort(), [
      't1',
    ]);

    expect(rows.map((r) => r.label)).toEqual(['Anna Bakker', 'Carla Smit']);
  });

  it('never duplicates a trainer who is in both', () => {
    const rows = prepareRows([trainer()], names, filters(), sort(), ['t1']);

    expect(rows).toHaveLength(1);
  });

  /** Without a roster nothing changes — the degraded path when Monday cannot be read. */
  it('falls back to the statistics alone', () => {
    const rows = prepareRows([trainer()], names, filters(), sort());

    expect(rows).toHaveLength(1);
  });
});
