import { z } from 'zod';

import { assertNoDuplicateIds } from '@lib/monday/completeness';
import { unionLinkedIds } from '@lib/monday/decode';

/**
 * How much work a trainer already has, this month and this year.
 *
 * Ported from legacy Airtable, where it is two formula fields on `Aanbevelingen`:
 *
 * ```
 * Trainingen.Maandsleutel      = DATETIME_FORMAT(Datum, 'YYYY-MM')
 * Trainers."Maanden trainingen" = rollup of Maandsleutel over ALL of a trainer's trainings
 *
 * Opdrachten deze maand = occurrences of THIS TRAINING's "2026-09" in that rollup
 * Opdrachten dit jaar   = occurrences of "2026" in it
 * ```
 *
 * Two things that reading is easy to get wrong, both confirmed from the formula rather
 * than inferred:
 *
 * - **"deze maand" is the month of the training being planned, not the current calendar
 *   month.** Planning a September training in August shows September's load, which is the
 *   figure a planner can act on.
 * - **Every linked training counts**, whatever its status. So unlike the evaluation work,
 *   this needs no completion signal — the thing that does not exist on the Agenda board.
 *
 * Scope: the configured Agenda board only. ITG's decision (10-Aug-2026) is that the
 * current year is enough and last year's work does not matter, so a trainer's history on
 * the 2025 board is deliberately invisible here.
 */

/** `YYYY-MM`, exactly as Airtable's `Maandsleutel`. */
export type MonthKey = string;

export interface AssignmentCounts {
  thisMonth: number;
  thisYear: number;
}

export const NO_ASSIGNMENTS: AssignmentCounts = { thisMonth: 0, thisYear: 0 };

/** trainer item id → month key → how many trainings that trainer has in it. */
export type AssignmentIndex = ReadonlyMap<string, ReadonlyMap<MonthKey, number>>;

/**
 * The whole scan: workload per trainer, plus every training's own month.
 *
 * The month is here rather than in the stored artifact because it is volatile too —
 * rescheduling a training from September to October does not advance its generation, so
 * a frozen month would keep counting October's trainers against September.
 */
export interface AgendaScan {
  workload: AssignmentIndex;
  /**
   * Every scanned training's month — `null` when it has no date.
   *
   * The null matters as much as the value: "scanned, and it has no date" must not look
   * like "not scanned", or clearing a training's date would silently fall back to the
   * month frozen in its stored rows.
   */
  monthByItemId: ReadonlyMap<string, MonthKey | null>;
}

/**
 * The month key for a Monday date cell.
 *
 * Monday renders dates as `YYYY-MM-DD`, so the key is a prefix — no parsing, no timezone
 * to get wrong. Anything else yields null and simply does not count, which is the right
 * outcome for a training with no date: it belongs to no month.
 */
export function monthKeyOf(date: string | null | undefined): MonthKey | null {
  if (typeof date !== 'string') {
    return null;
  }
  const match = /^(\d{4})-(\d{2})/.exec(date.trim());
  return match ? `${match[1]}-${match[2]}` : null;
}

export function yearOf(month: MonthKey): string {
  return month.slice(0, 4);
}

export function countsFor(
  index: AssignmentIndex,
  trainerItemId: string,
  month: MonthKey | null
): AssignmentCounts {
  const months = index.get(trainerItemId);
  if (months === undefined || month === null) {
    return NO_ASSIGNMENTS;
  }
  const year = yearOf(month);

  let thisYear = 0;
  for (const [key, count] of months) {
    if (yearOf(key) === year) {
      thisYear += count;
    }
  }
  return { thisMonth: months.get(month) ?? 0, thisYear };
}

/** One training as far as this cares: which it is, when it is, and who is on it. */
export interface AssignmentRow {
  itemId: string;
  date: string | null;
  trainerItemIds: readonly string[];
}

export function buildAgendaScan(rows: readonly AssignmentRow[]): AgendaScan {
  const workload = new Map<string, Map<MonthKey, number>>();
  const monthByItemId = new Map<string, MonthKey | null>();

  for (const row of rows) {
    const month = monthKeyOf(row.date);
    // Recorded either way — an undated training is scanned and monthless, which is a
    // different fact from one the scan never saw.
    monthByItemId.set(row.itemId, month);
    if (month === null) {
      continue;
    }
    for (const trainerItemId of row.trainerItemIds) {
      const months = workload.get(trainerItemId) ?? new Map<MonthKey, number>();
      months.set(month, (months.get(month) ?? 0) + 1);
      workload.set(trainerItemId, months);
    }
  }
  return { workload, monthByItemId };
}

/** Kept for tests that only care about the counts. */
export function buildAssignmentIndex(rows: readonly AssignmentRow[]): AssignmentIndex {
  return buildAgendaScan(rows).workload;
}

const pageSchema = z.object({
  cursor: z.string().nullable(),
  items: z.array(
    z.object({
      id: z.union([z.string(), z.number()]),
      column_values: z.array(
        z.object({
          id: z.string(),
          text: z.string().nullable().optional(),
          linked_item_ids: z.array(z.union([z.string(), z.number()])).optional(),
        })
      ),
    })
  ),
});

interface QueryClient {
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
}

interface ColumnIds {
  dateColumnId: string;
  /**
   * Elke relatiekolom die een trainer aan deze training koppelt, lead eerst.
   *
   * Meervoud sinds 21-Aug-2026: `board_relation_mkz4y7tb` draagt de leadtrainer en
   * `itg_cotrainers` de co-trainers. Alleen de eerste tellen zou een co-trainer als vrij
   * laten zien op een dag dat hij traint — en dat is precies de "plausibele nul" waar de
   * rest van dit bestand tegen beschermt.
   */
  trainerColumnIds: readonly string[];
}

function readPage(
  raw: unknown,
  first: boolean,
  columns: ColumnIds
): { rows: AssignmentRow[]; cursor: string | null } {
  const container =
    first && typeof raw === 'object' && raw !== null && 'boards' in raw
      ? (Array.isArray(raw.boards) ? raw.boards[0]?.items_page : undefined)
      : typeof raw === 'object' && raw !== null && 'next_items_page' in raw
        ? raw.next_items_page
        : undefined;

  const parsed = pageSchema.safeParse(container);
  if (!parsed.success) {
    /**
     * Fail closed, like every other read boundary here.
     *
     * An empty page would make the run SUCCEED and persist "0 opdrachten" for every
     * trainer — a number that looks exactly like a quiet month and is indistinguishable
     * from the truth on screen. A missing board, a renamed column or a Monday outage
     * must surface as a retryable failure, not as a plausible workload.
     */
    throw new Error(
      `Agenda scan returned an unreadable page: ${parsed.error.issues[0]?.message ?? 'unknown shape'}`
    );
  }

  const rows = parsed.data.items.map((item) => {
    const byId = new Map(item.column_values.map((c) => [c.id, c]));
    const date = byId.get(columns.dateColumnId);

    /**
     * The columns themselves must be there, not just the envelope.
     *
     * Monday omits a column it does not recognise instead of erroring, so a renamed or
     * retyped column silently drops every date (nothing lands in a month) or every
     * relation (nobody is busy) — and both come out as a plausible workload of zero.
     * An EMPTY value is fine: a training with no date or no trainer yet is normal. A
     * missing column, or a relation that is not a relation, is schema drift.
     */
    if (date === undefined) {
      throw new Error(`Agenda scan: date column "${columns.dateColumnId}" is missing from item ${item.id}`);
    }
    /**
     * Elke genoemde kolom moet terugkomen, niet alleen de eerste. Ontbreekt de
     * co-trainerkolom, dan is dat schemadrift met precies hetzelfde gezicht als "niemand
     * is co-trainer", en dan klopt de werklast van iedereen die erin staat niet meer.
     */
    const trainerItemIds = unionLinkedIds(
      columns.trainerColumnIds,
      (id) => byId.get(id),
      (id) => {
        throw new Error(`Agenda scan: "${id}" did not return a board relation on item ${item.id}`);
      }
    );

    return {
      itemId: String(item.id),
      date: date.text ?? null,
      trainerItemIds,
    };
  });
  return { rows, cursor: parsed.data.cursor };
}

const PAGE_SIZE = 500;
const MAX_PAGES = 8;

/**
 * Scan one Agenda board for dates and trainer links.
 *
 * Read once per execution and injected, exactly like the roster: it costs a couple of
 * paginated calls against a 25.000/day Monday budget, and re-reading it per training
 * would multiply that for no new information.
 */
export async function readAgendaScan(
  client: QueryClient,
  input: { boardId: string; dateColumnId: string; trainerColumnIds: readonly string[] }
): Promise<AgendaScan> {
  // The column ids travel with the call rather than sitting in module state: they differ
  // per Agenda board year — the trap that made 202 trainings look trainer-less during the
  // evaluation analysis — and shared mutable ids would let two runs corrupt each other.
  if (input.trainerColumnIds.length === 0) {
    throw new Error('Agenda scan: geen trainerkolom opgegeven; dat zou iedereen als vrij tellen');
  }
  const columnIds = [input.dateColumnId, ...input.trainerColumnIds]
    .map((id) => `"${id}"`)
    .join(',');
  const fields = `id column_values(ids:[${columnIds}]){ id text ... on BoardRelationValue { linked_item_ids } }`;
  const all: AssignmentRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let first = true;

  // Bounded: the Agenda board is ~800 items, so four pages is already generous. A
  // runaway cursor must not turn one run into an unbounded read.
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const document: string = first
      ? `query ($board: [ID!]) { boards(ids:$board){ items_page(limit:${PAGE_SIZE}){ cursor items{ ${fields} } } } }`
      : `query ($cursor: String!) { next_items_page(limit:${PAGE_SIZE}, cursor:$cursor){ cursor items{ ${fields} } } }`;

    const raw: unknown = await client.query(
      document,
      first ? { board: [input.boardId] } : { cursor }
    );
    const { rows, cursor: next } = readPage(raw, first, input);
    all.push(...rows);
    first = false;
    cursor = next;

    if (cursor === null) {
      /**
       * The cursor guard catches a repeated PAGE; this catches a repeated ITEM.
       *
       * Monday paginates a live board, so an item edited mid-scan can shift and appear
       * on two consecutive pages. `buildAgendaScan` would then count that training twice
       * for every trainer on it, and the inflated workload would be cached as
       * authoritative for five minutes — the same "plausible but wrong number" this
       * whole subsystem keeps guarding against, in the opposite direction.
       *
       * Reuses the repository's existing guard, the one `graphql-client.ts` applies to
       * every other paginated board read.
       */
      assertNoDuplicateIds(
        all.map((row) => row.itemId),
        `Agenda scan (board ${input.boardId})`
      );
      return buildAgendaScan(all);
    }
    // A repeated cursor would loop us over the same page and double every count in it.
    if (seen.has(cursor)) {
      throw new Error('Agenda scan: Monday repeated a pagination cursor');
    }
    seen.add(cursor);
  }

  /**
   * Still paging after the cap. Returning what we have would cache a PARTIAL board as
   * authoritative — understating every trainer's workload, plausibly. The board is ~800
   * items against a 4000-item budget, so reaching this means something changed.
   */
  throw new Error(`Agenda scan: more than ${MAX_PAGES * PAGE_SIZE} items, refusing a partial index`);
}
