import { describe, expect, it } from 'vitest';

import { AGENDA_2026_COLUMNS } from '@lib/monday/board-config';

import { formatTrainingDate, readTrainingDate } from '../training-date';

const COLUMN = AGENDA_2026_COLUMNS.datum;

function itemWith(column: Record<string, unknown>): unknown {
  return { items: [{ id: '111', column_values: [column] }] };
}

describe('formatTrainingDate', () => {
  it('writes the date the way a planner reads it', () => {
    expect(formatTrainingDate('2026-03-24')).toBe('dinsdag 24 maart 2026');
  });

  /**
   * The date is a calendar day, not a moment. Formatting it in the browser's own zone
   * would render `2026-03-24` as maandag 23 maart for anyone west of UTC — a planner in
   * a different timezone would be told the wrong day of the week for the training.
   */
  it('formats in UTC, so the calendar day never shifts', () => {
    expect(formatTrainingDate('2026-01-01')).toBe('donderdag 1 januari 2026');
  });

  it('refuses anything that is not a real calendar date', () => {
    expect(formatTrainingDate('2026-02-30')).toBeNull();
    expect(formatTrainingDate('2026-13-01')).toBeNull();
    expect(formatTrainingDate('24-03-2026')).toBeNull();
    expect(formatTrainingDate('')).toBeNull();
    expect(formatTrainingDate(null)).toBeNull();
  });
});

describe('readTrainingDate', () => {
  it('takes the date off the DateValue fragment', () => {
    expect(readTrainingDate(itemWith({ id: COLUMN, date: '2026-03-24' }), COLUMN)).toBe('2026-03-24');
  });

  /** An empty date column is ordinary — the training simply has no date yet. */
  it('reads an empty date as no date', () => {
    expect(readTrainingDate(itemWith({ id: COLUMN, date: null }), COLUMN)).toBeNull();
  });

  /**
   * `... on DateValue` does not match once the column stops being a date, and GraphQL
   * omits the field rather than erroring. That is drift, and it reads as no date — which
   * is the safe direction here: the header simply says nothing.
   */
  it('reads a retyped column as no date', () => {
    expect(readTrainingDate(itemWith({ id: COLUMN, text: '2026-03-24' }), COLUMN)).toBeNull();
  });

  it('survives a reply that carries no such column, item or items', () => {
    expect(readTrainingDate(itemWith({ id: 'other_column', date: '2026-03-24' }), COLUMN)).toBeNull();
    expect(readTrainingDate({ items: [] }, COLUMN)).toBeNull();
    expect(readTrainingDate({}, COLUMN)).toBeNull();
    expect(readTrainingDate(null, COLUMN)).toBeNull();
  });
});
