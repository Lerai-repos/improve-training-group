import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AGENDA_2026_COLUMNS } from '@lib/monday/board-config';

import { headerFields, readTrainingHeader } from '../training-header';
import { useTrainingHeader } from '../use-training-header';

import type { MondayBridge, MondayContext } from '../monday-client';

afterEach(cleanup);

const C = AGENDA_2026_COLUMNS;

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

function itemWith(...columns: Record<string, unknown>[]): unknown {
  return { items: [{ id: '111', column_values: columns }] };
}

/**
 * One real training, exactly as the live board returns it — mirror and relation with
 * `text: null`, times written by hand, hours as a decimal number.
 */
const ELEOS = itemWith(
  { id: C.datum, text: '2026-09-24', date: '2026-09-24' },
  { id: C.companyMirror, text: null, display_value: 'Eleos' },
  { id: C.themaRelation, text: null, display_value: 'Maatwerk' },
  { id: C.tijd, text: '09:00-13:00' },
  { id: C.locatie, text: 'Duinweg 1 3735 LA Bosch en Duin' }
);

describe('readTrainingHeader', () => {
  it('reads every field a planner asked for', () => {
    expect(readTrainingHeader(ELEOS)).toEqual({
      datum: 'donderdag 24 september 2026',
      klant: 'Eleos',
      thema: 'Maatwerk',
      tijden: '09:00-13:00',
      locatie: 'Duinweg 1 3735 LA Bosch en Duin',
    });
  });

  /**
   * The two most identifying fields both arrive as `text: null`. Measured on the live
   * board: `Bedrijf` returns 0 of 816 through `text` and 816 of 816 through
   * `display_value`, and the theme relation behaves the same way. Reading `text` alone
   * would leave the client and theme permanently blank.
   */
  it('takes the client and theme from display_value, not text', () => {
    const header = readTrainingHeader(
      itemWith(
        { id: C.companyMirror, text: null, display_value: 'Nexperia' },
        { id: C.themaRelation, text: null, display_value: 'Time management' }
      )
    );
    expect(header.klant).toBe('Nexperia');
    expect(header.thema).toBe('Time management');
  });

  /**
   * Times and locations are free text on the live board and must pass through untouched.
   * Normalising `11.00-15.45 uur (inclusief lunch pauze)` would throw away the note a
   * planner needs, and tidying `Utrecht, Nederland` into an address would invent
   * precision the cell does not have.
   */
  it('passes times and locations through verbatim', () => {
    const header = readTrainingHeader(
      itemWith(
        { id: C.tijd, text: '11.00-15.45 uur (inclusief lunch pauze)' },
        { id: C.locatie, text: 'Utrecht, Nederland' }
      )
    );
    expect(header.tijden).toBe('11.00-15.45 uur (inclusief lunch pauze)');
    expect(header.locatie).toBe('Utrecht, Nederland');
  });

  /** A field that cannot be read costs one line, never the list. */
  it('survives an empty, drifted or absent reply', () => {
    expect(readTrainingHeader(itemWith({ id: C.tijd, text: '   ' })).tijden).toBeNull();
    // Retyped: `... on DateValue` stops matching and GraphQL omits `date` entirely.
    expect(readTrainingHeader(itemWith({ id: C.datum, text: '2026-09-24' })).datum).toBeNull();
    expect(readTrainingHeader({ items: [] })).toEqual(readTrainingHeader(null));
    expect(readTrainingHeader({})).toEqual(readTrainingHeader(undefined));
    expect(headerFields(readTrainingHeader(null))).toEqual([]);
  });
});

describe('headerFields', () => {
  it('lists the fields in the order ITG asked for', () => {
    expect(headerFields(readTrainingHeader(ELEOS)).map((field) => field.label)).toEqual([
      'Datum',
      'Klant',
      'Thema',
      'Tijden',
      'Locatie',
    ]);
  });

  /**
   * Left out, not held open with a dash. An empty slot under the heading reads as a
   * missing value on a training that may simply not be scheduled yet.
   */
  it('drops the fields that have no value', () => {
    const header = readTrainingHeader(
      itemWith({ id: C.companyMirror, display_value: 'Alpine' }, { id: C.locatie, text: '' })
    );
    expect(headerFields(header)).toEqual([{ label: 'Klant', value: 'Alpine' }]);
  });
});

describe('useTrainingHeader', () => {
  it('resolves the training’s details', async () => {
    const monday = bridge(() => Promise.resolve(ELEOS));

    const { result } = renderHook(() => useTrainingHeader(monday, '111'));

    await waitFor(() => {
      expect(result.current.header.klant).toBe('Eleos');
    });
    expect(result.current.header.datum).toBe('donderdag 24 september 2026');
  });

  it('asks Monday for those columns of that item alone', async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const monday = bridge((variables) => {
      seen.push(variables);
      return Promise.resolve(ELEOS);
    });

    const { result } = renderHook(() => useTrainingHeader(monday, '222'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(seen).toEqual([
      {
        ids: ['222'],
        cols: [C.datum, C.companyMirror, C.themaRelation, C.tijd, C.locatie],
      },
    ]);
  });

  it('has nothing to show before an item is known', () => {
    const monday = bridge(() => Promise.reject(new Error('should not be called')));

    const { result } = renderHook(() => useTrainingHeader(monday, null));

    expect(headerFields(result.current.header)).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  /**
   * Display only: a header that cannot be filled is left out. Anything that actually
   * blocks a recommendation is already reported where it matters — the run fails and the
   * view says so.
   */
  it('shows nothing when Monday cannot be reached', async () => {
    const monday = bridge(() => Promise.reject(new Error('network')));

    const { result } = renderHook(() => useTrainingHeader(monday, '111'));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(headerFields(result.current.header)).toEqual([]);
  });

  /** The iframe is not remounted when the planner clicks the next training. */
  it('follows the item to a new training', async () => {
    const monday = bridge((variables) => {
      const ids = variables?.ids;
      const id = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : '';
      return Promise.resolve(
        itemWith({ id: C.companyMirror, display_value: id === '111' ? 'Eleos' : 'Alpine' })
      );
    });

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useTrainingHeader(monday, id),
      { initialProps: { id: '111' } }
    );
    await waitFor(() => {
      expect(result.current.header.klant).toBe('Eleos');
    });

    rerender({ id: '222' });

    await waitFor(() => {
      expect(result.current.header.klant).toBe('Alpine');
    });
  });

  /**
   * NEVER training A's client under training B's heading, not even for one render.
   *
   * React renders the new item before the effect that clears the old answer runs, and the
   * header is not masked while the list reloads — so a result merely *cleared by an
   * effect* is painted as if it belonged to this training. `act()` flushes that effect
   * before `result.current` can be read, which is why this is asserted over every render
   * the hook performed rather than over the settled value: the bad frame is real in a
   * browser and invisible to a settled read.
   *
   * It matters more here than it did for the date alone. A wrong date is visibly wrong;
   * a wrong location under the right client is a planner briefing someone to drive to the
   * previous training's address.
   */
  it('never labels one training with another’s details', async () => {
    const klanten: Record<string, string> = { '111': 'Eleos', '222': 'Alpine' };
    const monday = bridge((variables) => {
      const ids = variables?.ids;
      const id = Array.isArray(ids) && typeof ids[0] === 'string' ? ids[0] : '';
      return Promise.resolve(
        itemWith(
          { id: C.companyMirror, display_value: klanten[id] ?? null },
          { id: C.locatie, text: id === '111' ? 'Bosch en Duin' : 'Utrecht' }
        )
      );
    });

    const seen: Array<{ id: string; klant: string | null; locatie: string | null }> = [];
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => {
        const state = useTrainingHeader(monday, id);
        seen.push({ id, klant: state.header.klant, locatie: state.header.locatie });
        return state;
      },
      { initialProps: { id: '111' } }
    );
    await waitFor(() => {
      expect(result.current.header.klant).toBe('Eleos');
    });

    rerender({ id: '222' });
    await waitFor(() => {
      expect(result.current.header.klant).toBe('Alpine');
    });

    const locaties: Record<string, string> = { '111': 'Bosch en Duin', '222': 'Utrecht' };
    expect(
      seen.filter(
        (frame) =>
          (frame.klant !== null && frame.klant !== klanten[frame.id]) ||
          (frame.locatie !== null && frame.locatie !== locaties[frame.id])
      )
    ).toEqual([]);
  });
});
