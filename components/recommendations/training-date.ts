/**
 * The training's own date, read off the Monday item and written for a planner.
 *
 * It deliberately does NOT travel with the recommendation list. That list is an artifact
 * computed once and stored; the date is a live property of the training that a planner
 * can change at any moment, and freezing a copy of it into the artifact would leave the
 * header showing yesterday's answer until someone recalculated. Reading it beside the
 * list keeps the header true and leaves the stored shape alone.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Weekday included, because that is what the planner is actually checking against —
 * "kan die dinsdag" is the question, not "kan die de 24e".
 *
 * **UTC, explicitly.** A Monday date column holds a calendar day, not a moment. Formatted
 * in the browser's own zone, `2026-03-24` renders as maandag 23 maart for anyone west of
 * UTC — the wrong weekday for the one field this header exists to show.
 */
const DUTCH_DATE = new Intl.DateTimeFormat('nl-NL', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * A real calendar date, or null. Round-tripped through UTC so `2026-02-30` — which
 * matches the pattern and would otherwise roll forward into March — is rejected rather
 * than silently renamed.
 */
function parseIsoDate(iso: string): Date | null {
  const match = ISO_DATE.exec(iso.trim());
  if (match === null) {
    return null;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function formatTrainingDate(iso: string | null): string | null {
  if (iso === null || iso === '') {
    return null;
  }
  const date = parseIsoDate(iso);
  return date === null ? null : DUTCH_DATE.format(date);
}

/**
 * The `date` field of the requested column, walked out of whatever came back.
 *
 * Fails to null rather than throwing, and that is the whole difference with
 * `readLinkedTrainers`: nothing is written on the strength of this value. A drifted or
 * unreadable column costs one line in the header, while a throw would take a working
 * list down over a decoration.
 */
export function readTrainingDate(data: unknown, columnId: string): string | null {
  if (typeof data !== 'object' || data === null || !('items' in data)) {
    return null;
  }
  const { items } = data;
  if (!Array.isArray(items) || items.length === 0) {
    return null;
  }
  const [item] = items;
  if (typeof item !== 'object' || item === null || !('column_values' in item)) {
    return null;
  }
  const columns = item.column_values;
  if (!Array.isArray(columns)) {
    return null;
  }
  const column = columns.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      'id' in candidate &&
      candidate.id === columnId
  );
  // `... on DateValue` simply does not match once the column stops being a date, and
  // GraphQL then omits `date` rather than erroring — so an absent key IS the drift
  // signal, and it reads the same as an empty column: no date to show.
  if (typeof column !== 'object' || column === null || !('date' in column)) {
    return null;
  }
  return typeof column.date === 'string' && column.date !== '' ? column.date : null;
}
