import { AGENDA_2026_COLUMNS } from '@lib/monday/board-config';

import { formatTrainingDate } from './training-date';

/**
 * The training's own details, above the recommendations.
 *
 * ITG asked for this directly: the header showed only the date, and a planner deciding
 * who to send also wants to see who it is for, on what theme, at what times and where.
 *
 * Read live beside the list, never frozen into the stored artifact, for the same reason
 * the date already was: every one of these is a property a planner can change at any
 * moment, and a copy taken at computation time would keep showing yesterday's answer
 * until somebody recalculated.
 */

const C = AGENDA_2026_COLUMNS;

/**
 * Every column the header needs, in one request.
 *
 * `tijd` is optional on a `TrainingColumnMap` — the older year boards do not have it —
 * so it is filtered out rather than asserted present. Asking Monday for `undefined`
 * would not fail loudly; it would return a column list one entry short and leave the
 * times line quietly missing on the board that does have it.
 */
export const HEADER_COLUMN_IDS: readonly string[] = [
  C.datum,
  C.companyMirror,
  C.themaRelation,
  C.tijd,
  C.duur,
  C.locatie,
].filter((id): id is string => id !== undefined);

export interface TrainingHeader {
  readonly datum: string | null;
  readonly klant: string | null;
  readonly thema: string | null;
  readonly tijden: string | null;
  readonly duur: string | null;
  readonly locatie: string | null;
}

export const EMPTY_HEADER: TrainingHeader = {
  datum: null,
  klant: null,
  thema: null,
  tijden: null,
  duur: null,
  locatie: null,
};

/** The cells of the first returned item, by column id. Anything unexpected yields none. */
function cellsOf(data: unknown): Map<string, Record<string, unknown>> {
  const empty = new Map<string, Record<string, unknown>>();
  if (typeof data !== 'object' || data === null || !('items' in data)) {
    return empty;
  }
  const { items } = data;
  if (!Array.isArray(items) || items.length === 0) {
    return empty;
  }
  const [item] = items;
  if (typeof item !== 'object' || item === null || !('column_values' in item)) {
    return empty;
  }
  const columns = item.column_values;
  if (!Array.isArray(columns)) {
    return empty;
  }
  const cells = new Map<string, Record<string, unknown>>();
  for (const column of columns) {
    if (typeof column === 'object' && column !== null && 'id' in column) {
      const { id } = column;
      if (typeof id === 'string') {
        cells.set(id, { ...column });
      }
    }
  }
  return cells;
}

const asText = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * A cell's value as text, preferring `display_value`.
 *
 * Both the client and the theme need it. Measured on the live board: `Bedrijf`
 * (`lookup_mkszzfvr`, a mirror) and the theme relation both return `text: null` and put
 * the value in `display_value`, so reading `text` alone would leave the two most
 * identifying fields permanently blank — a header that looks broken rather than empty.
 */
function cellText(
  cells: Map<string, Record<string, unknown>>,
  /** Undefined when this board has no such column at all — one line short, never a throw. */
  id: string | undefined
): string | null {
  const cell = id === undefined ? undefined : cells.get(id);
  if (cell === undefined) {
    return null;
  }
  return asText(cell.display_value) ?? asText(cell.text);
}

/**
 * Hours as ITG writes them, with the unit attached.
 *
 * The column is numeric, so `4.75` is what comes back and `4,75 uur` is what a Dutch
 * planner reads. Anything non-numeric is passed through untouched rather than dropped:
 * this is decoration, and showing whatever is in the cell beats hiding it because it did
 * not parse.
 */
function formatDuur(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  const hours = Number(raw);
  if (!Number.isFinite(hours)) {
    return raw;
  }
  return `${String(hours).replace('.', ',')} uur`;
}

/**
 * The header for the item in `data`.
 *
 * Every field fails to null independently, and none of them throws — the same rule the
 * date already followed. Nothing is written on the strength of these values, so a
 * renamed or retyped column costs one line of the header, where a throw would take down
 * a list of recommendations that is otherwise perfectly good.
 */
export function readTrainingHeader(data: unknown): TrainingHeader {
  const cells = cellsOf(data);
  return {
    datum: formatTrainingDate(asText(cells.get(C.datum)?.date)),
    klant: cellText(cells, C.companyMirror),
    thema: cellText(cells, C.themaRelation),
    /**
     * Verbatim, both of these.
     *
     * The live board holds `09:00-13:00`, `14:00 - 17:00` and
     * `11.00-15.45 uur (inclusief lunch pauze)` in the same column, and locations range
     * from a full address to `Utrecht, Nederland`. Normalising would either throw away
     * the parenthetical the planner needs or invent a precision the cell does not have.
     */
    tijden: cellText(cells, C.tijd),
    duur: formatDuur(cellText(cells, C.duur)),
    locatie: cellText(cells, C.locatie),
  };
}

export interface HeaderField {
  readonly label: string;
  readonly value: string;
}

/**
 * The fields worth showing, in the order ITG asked for them.
 *
 * Empty ones are left out rather than held open with a dash. An empty slot under the
 * heading reads as a missing value on a training that may simply not be dated or located
 * yet, and this row is decoration for a list that stands on its own.
 */
export function headerFields(header: TrainingHeader): readonly HeaderField[] {
  const all: readonly HeaderField[] = [
    { label: 'Datum', value: header.datum ?? '' },
    { label: 'Klant', value: header.klant ?? '' },
    { label: 'Thema', value: header.thema ?? '' },
    { label: 'Tijden', value: header.tijden ?? '' },
    { label: 'Duur', value: header.duur ?? '' },
    { label: 'Locatie', value: header.locatie ?? '' },
  ];
  return all.filter((field) => field.value !== '');
}
