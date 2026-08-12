/**
 * Read every training's trainer, thema, IE-code and date across every wired Agenda
 * jaargang.
 *
 * Uses the hand-rolled `items_page(limit: 500)` reader that `assignments.ts` already
 * proves, not `fetchBoardItems`: the latter does an inventory pass plus a heavy pass at
 * 100 items per page and pulls all 60-70 columns, which is 38 calls a night for two
 * boards. Four narrow columns at 500 a page is 4, plus one `getSchema` for both boards.
 *
 * Fail-closed throughout, and for one reason: everything downstream treats an absent
 * (trainer, thema) pair as "never taught". A page this reader silently drops is not a
 * gap, it is a false fact on a planner's screen — and the nightly delta would then blank
 * the rows to match.
 */

import { z } from 'zod';

import { assertCountMatches, assertNoDuplicateIds } from '@lib/monday/completeness';
import { assertColumns } from '@lib/monday/schema-check';

import { AGENDA_HISTORY_BOARDS, agendaHistoryExpectedColumns } from './agenda-columns';

import type { BoardMeta } from '@lib/monday/graphql-client';
import type { AgendaHistoryColumns } from './agenda-columns';
import type { TrainingHistoryEntry, TrainingRef } from './types';

const PAGE_SIZE = 500;
/** 6.000 items against a 943-item worst case: only a runaway cursor reaches this. */
const MAX_PAGES = 12;

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

export interface AgendaHistoryClient {
  query<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
  getSchema(boardIds: string[]): Promise<BoardMeta[]>;
}

/** One training, carrying both the roll-up's view of it and the join's. */
export interface AgendaTraining {
  readonly entry: TrainingHistoryEntry;
  readonly ref: TrainingRef;
  readonly boardId: string;
}

export interface AgendaHistory {
  readonly trainings: readonly AgendaTraining[];
  readonly perBoard: ReadonlyArray<{
    readonly boardId: string;
    readonly jaargang: string;
    readonly items: number;
    readonly pages: number;
  }>;
}

function unwrapPage(raw: unknown, first: boolean): unknown {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  if (first) {
    return 'boards' in raw && Array.isArray(raw.boards) ? raw.boards[0]?.items_page : undefined;
  }
  return 'next_items_page' in raw ? raw.next_items_page : undefined;
}

function readPage(
  raw: unknown,
  first: boolean,
  columns: AgendaHistoryColumns
): { trainings: AgendaTraining[]; cursor: string | null } {
  const parsed = pageSchema.safeParse(unwrapPage(raw, first));
  if (!parsed.success) {
    throw new Error(
      `Agenda history (${columns.jaargang}): unreadable page — ` +
        `${parsed.error.issues[0]?.message ?? 'unknown shape'}`
    );
  }

  const trainings = parsed.data.items.map((item) => {
    const byId = new Map(item.column_values.map((c) => [c.id, c]));
    const datum = byId.get(columns.datum);
    const ieCode = byId.get(columns.ieCode);
    const trainers = byId.get(columns.trainerRelation);
    const themas = byId.get(columns.themaRelation);

    /**
     * The COLUMN must be present, not just the envelope. Monday omits an id it does not
     * recognise, so a renamed column drops every value while the request still succeeds.
     * An empty VALUE is fine — undated, trainer-less and code-less trainings are all
     * normal and are counted as such downstream.
     */
    const where = `item ${item.id} on board ${columns.boardId} (${columns.jaargang})`;
    if (datum === undefined) {
      throw new Error(`Agenda history: date column "${columns.datum}" missing from ${where}`);
    }
    if (ieCode === undefined) {
      throw new Error(`Agenda history: IE-code column "${columns.ieCode}" missing from ${where}`);
    }
    if (trainers === undefined || trainers.linked_item_ids === undefined) {
      throw new Error(
        `Agenda history: "${columns.trainerRelation}" is not a board relation on ${where}`
      );
    }
    if (themas === undefined || themas.linked_item_ids === undefined) {
      throw new Error(
        `Agenda history: "${columns.themaRelation}" is not a board relation on ${where}`
      );
    }

    const trainingItemId = String(item.id);
    const raw = ieCode.text ?? '';
    return {
      boardId: columns.boardId,
      entry: {
        trainingItemId,
        datum: datum.text === undefined || datum.text === null || datum.text === '' ? null : datum.text,
        trainerExternalIds: trainers.linked_item_ids.map(String),
        themaExternalIds: themas.linked_item_ids.map(String),
      },
      ref: {
        trainingItemId,
        rawIeCode: raw.trim() === '' ? null : raw,
        // The klant is not read here: it only classifies an ambiguity as same- or
        // cross-client, and pulling a mirror column for every training on two boards is
        // a real cost for a reporting nicety. Filled in by the caller if wanted.
        clientKey: null,
      },
    };
  });

  return { trainings, cursor: parsed.data.cursor };
}

async function readBoard(
  client: AgendaHistoryClient,
  columns: AgendaHistoryColumns,
  itemsCount: number | null
): Promise<{ trainings: AgendaTraining[]; pages: number }> {
  const fields =
    `id column_values(ids:["${columns.datum}","${columns.ieCode}",` +
    `"${columns.trainerRelation}","${columns.themaRelation}"])` +
    `{ id text ... on BoardRelationValue { linked_item_ids } }`;

  const all: AgendaTraining[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let first = true;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const document: string = first
      ? `query ($board: [ID!]) { boards(ids:$board){ items_page(limit:${PAGE_SIZE}){ cursor items{ ${fields} } } } }`
      : `query ($cursor: String!) { next_items_page(limit:${PAGE_SIZE}, cursor:$cursor){ cursor items{ ${fields} } } }`;

    const raw: unknown = await client.query(
      document,
      first ? { board: [columns.boardId] } : { cursor }
    );
    const result = readPage(raw, first, columns);
    all.push(...result.trainings);
    first = false;
    cursor = result.cursor;

    if (cursor === null) {
      // A live board can shift an edited item onto two consecutive pages; counting it
      // twice would inflate `timesTaught` for every pair on it.
      const label = `Agenda history (board ${columns.boardId}, ${columns.jaargang})`;
      assertNoDuplicateIds(
        all.map((t) => t.entry.trainingItemId),
        label
      );
      /**
       * EXACT, against the board's own count — not the floor below it.
       *
       * The floor cannot see a truncated read: 700 of 776 items clears it comfortably,
       * and the resulting history is short by 76 trainings with no error anywhere. The
       * schema already told us how many there should be, so prove it.
       */
      assertCountMatches(new Set(all.map((t) => t.entry.trainingItemId)).size, itemsCount, label);
      /**
       * The floor still earns its place, for the case `items_count` cannot catch: a board
       * that genuinely IS nearly empty because someone emptied it. Completeness and
       * plausibility are different questions.
       */
      if (all.length < columns.minimumItems) {
        throw new Error(
          `${label} returned ${all.length} items, below the floor of ${columns.minimumItems} — ` +
            `refusing a suspiciously small history`
        );
      }
      return { trainings: all, pages: page + 1 };
    }
    if (seen.has(cursor)) {
      throw new Error(`Agenda history: Monday repeated a pagination cursor on ${columns.boardId}`);
    }
    seen.add(cursor);
  }

  throw new Error(
    `Agenda history: board ${columns.boardId} exceeded ${MAX_PAGES * PAGE_SIZE} items, ` +
      `refusing a partial history`
  );
}

/**
 * Read every wired jaargang, or throw.
 *
 * All-or-nothing by construction: there is no per-board `try`, because a partial history
 * is exactly the input that turns into mass blanking downstream.
 */
export async function readAgendaHistory(
  client: AgendaHistoryClient,
  boards: readonly AgendaHistoryColumns[] = AGENDA_HISTORY_BOARDS
): Promise<AgendaHistory> {
  // One schema call for every board, then per-board drift checks.
  const metas = await client.getSchema(boards.map((b) => b.boardId));
  const metaById = new Map(metas.map((m) => [String(m.id), m]));
  for (const columns of boards) {
    const meta = metaById.get(columns.boardId);
    if (meta === undefined) {
      throw new Error(`Agenda history: board ${columns.boardId} (${columns.jaargang}) not found`);
    }
    assertColumns(meta, [...agendaHistoryExpectedColumns(columns)]);
  }

  const trainings: AgendaTraining[] = [];
  const perBoard: Array<{ boardId: string; jaargang: string; items: number; pages: number }> = [];
  for (const columns of boards) {
    const result = await readBoard(client, columns, metaById.get(columns.boardId)?.items_count ?? null);
    trainings.push(...result.trainings);
    perBoard.push({
      boardId: columns.boardId,
      jaargang: columns.jaargang,
      items: result.trainings.length,
      pages: result.pages,
    });
  }

  // A Monday pulse id is globally unique, so a collision across boards means we read
  // the same board twice — a config bug that would double every count it touches.
  assertNoDuplicateIds(
    trainings.map((t) => t.entry.trainingItemId),
    'Agenda history (across boards)'
  );

  return { trainings, perBoard };
}
