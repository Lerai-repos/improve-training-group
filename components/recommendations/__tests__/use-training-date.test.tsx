import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENDA_2026_COLUMNS } from '@lib/monday/board-config';

import { formatTrainingDate, readTrainingDate } from '../training-date';
import { useTrainingDate } from '../use-training-date';

import type { MondayBridge, MondayContext } from '../monday-client';

afterEach(cleanup);

const COLUMN = AGENDA_2026_COLUMNS.datum;

/** A bridge whose API answers with whatever the test hands it. */
function bridge(answer: (variables?: Record<string, unknown>) => Promise<unknown>): MondayBridge {
  const context: MondayContext = { itemId: '111', boardId: '5087396949', theme: 'light' };
  return {
    context: () => Promise.resolve(context),
    onContextChange: () => () => undefined,
    sessionToken: () => Promise.resolve('token'),
    api: (_document: string, variables?: Record<string, unknown>) => answer(variables),
  };
}

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

describe('useTrainingDate', () => {
  it('resolves the training’s date to a label', async () => {
    const monday = bridge(() => Promise.resolve(itemWith({ id: COLUMN, date: '2026-03-24' })));

    const { result } = renderHook(() => useTrainingDate(monday, '111'));

    await waitFor(() => {
      expect(result.current.label).toBe('dinsdag 24 maart 2026');
    });
    expect(result.current.iso).toBe('2026-03-24');
  });

  it('asks Monday for the date column of that item alone', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const monday = bridge((variables) => {
      seen.push(variables);
      return Promise.resolve(itemWith({ id: COLUMN, date: '2026-03-24' }));
    });

    const { result } = renderHook(() => useTrainingDate(monday, '222'));

    await waitFor(() => {
      expect(result.current.label).not.toBeNull();
    });
    expect(seen).toEqual([{ ids: ['222'], cols: [COLUMN] }]);
  });

  it('has no label before an item is known', () => {
    const monday = bridge(() => Promise.reject(new Error('should not be called')));

    const { result } = renderHook(() => useTrainingDate(monday, null));

    expect(result.current.label).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  /**
   * Display only: a header line that cannot be filled is left out. A missing or unusable
   * date on the board is already reported where it matters — the engine fails the run
   * with `invalid_date` and the view says so.
   */
  it('shows no date when Monday cannot be reached', async () => {
    const monday = bridge(() => Promise.reject(new Error('network')));

    const { result } = renderHook(() => useTrainingDate(monday, '111'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.label).toBeNull();
  });

  /** The iframe is not remounted when the planner clicks the next training. */
  it('follows the item to a new date', async () => {
    const dates: Record<string, string> = { '111': '2026-03-24', '222': '2026-04-01' };
    const monday = bridge((variables) => {
      const ids = variables?.ids;
      const id = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : '';
      return Promise.resolve(itemWith({ id: COLUMN, date: dates[id] ?? null }));
    });

    const { result, rerender } = renderHook(({ id }: { id: string }) => useTrainingDate(monday, id), {
      initialProps: { id: '111' },
    });
    await waitFor(() => {
      expect(result.current.label).toBe('dinsdag 24 maart 2026');
    });

    rerender({ id: '222' });

    await waitFor(() => {
      expect(result.current.label).toBe('woensdag 1 april 2026');
    });
  });

  /**
   * NEVER training A's date under training B's heading, not even for one render.
   *
   * React renders the new item before the effect that clears the old answer runs, and the
   * header is not masked while the list reloads — so a result merely *cleared by an
   * effect* is painted as if it were this training's date. `act()` flushes that effect
   * before `result.current` can be read, which is why this is asserted over every render
   * the hook performed rather than over the settled value: the bad frame is real in a
   * browser and invisible to a settled read.
   */
  it('never labels one training with another’s date', async () => {
    const dates: Record<string, string> = { '111': '2026-03-24', '222': '2026-04-01' };
    const labels: Record<string, string> = {
      '111': 'dinsdag 24 maart 2026',
      '222': 'woensdag 1 april 2026',
    };
    const monday = bridge((variables) => {
      const ids = variables?.ids;
      const id = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : '';
      return Promise.resolve(itemWith({ id: COLUMN, date: dates[id] ?? null }));
    });

    const seen: Array<{ id: string; label: string | null }> = [];
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => {
        const date = useTrainingDate(monday, id);
        seen.push({ id, label: date.label });
        return date;
      },
      { initialProps: { id: '111' } }
    );
    await waitFor(() => {
      expect(result.current.label).toBe(labels['111']);
    });

    rerender({ id: '222' });
    await waitFor(() => {
      expect(result.current.label).toBe(labels['222']);
    });

    expect(seen.filter((frame) => frame.label !== null && frame.label !== labels[frame.id])).toEqual(
      []
    );
  });
});
