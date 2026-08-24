import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGENDA_2025_HISTORY, AGENDA_2026_HISTORY } from '../agenda-columns';
import { readAgendaHistory } from '../agenda-history';

import type { BoardMeta } from '@lib/monday/graphql-client';
import type { AgendaHistoryClient } from '../agenda-history';
import type { AgendaHistoryColumns } from '../agenda-columns';

/**
 * The reader is judged on what it does with a MALFORMED or SHRUNKEN answer, not on the
 * happy path: everything downstream reads an absent (trainer, thema) pair as "never
 * taught", so a page this reader drops becomes a false fact rather than a gap.
 */

const TRAINERS_BOARD = '1661151090';
const THEMAS_BOARD = '5067928440';
const KLANTEN_BOARD = '1279052045';

const columnsOf = (c: AgendaHistoryColumns): BoardMeta['columns'] => [
  {
    id: c.trainerRelation,
    title: 'Trainers',
    type: 'board_relation',
    settings_str: `{"boardIds":[${TRAINERS_BOARD}]}`,
  },
  ...(c.coTrainerRelation === undefined
    ? []
    : [
        {
          id: c.coTrainerRelation,
          title: 'Co-trainer(s)',
          type: 'board_relation',
          settings_str: `{"boardIds":[${TRAINERS_BOARD}]}`,
        },
      ]),
  {
    id: c.themaRelation,
    title: "Thema's",
    type: 'board_relation',
    settings_str: `{"boardIds":[${THEMAS_BOARD}]}`,
  },
  {
    id: c.klantRelation,
    title: 'Opportunities',
    type: 'board_relation',
    settings_str: `{"boardIds":[${KLANTEN_BOARD}]}`,
  },
  { id: c.ieCode, title: 'IE-code', type: 'text', settings_str: null },
  { id: c.datum, title: 'Datum', type: 'date', settings_str: null },
];

const metaOf = (c: AgendaHistoryColumns, over: Partial<BoardMeta> = {}): BoardMeta => ({
  id: c.boardId,
  name: `Agenda ${c.jaargang}`,
  groups: [],
  columns: columnsOf(c),
  items_count: 1000,
  ...over,
});

interface RawItem {
  id: string;
  column_values: Array<{ id: string; text?: string | null; linked_item_ids?: string[] }>;
}

/**
 * An override REPLACES the whole cell rather than merging into it — otherwise
 * `{ text: 'NLP' }` over a relation leaves `linked_item_ids` in place and the
 * "column got retyped" case silently tests nothing.
 */
const item = (
  id: string,
  c: AgendaHistoryColumns,
  over: Partial<Record<string, Record<string, unknown>>> = {}
): RawItem => ({
  id,
  column_values: [
    { id: c.datum, text: '2026-01-01' },
    { id: c.ieCode, text: `IE${id}` },
    { id: c.trainerRelation, linked_item_ids: ['tr1'] },
    ...(c.coTrainerRelation === undefined
      ? []
      : [{ id: c.coTrainerRelation, linked_item_ids: [] as string[] }]),
    { id: c.themaRelation, linked_item_ids: ['th1'] },
    { id: c.klantRelation, linked_item_ids: ['kl1'] },
  ].map((cv) => (over[cv.id] === undefined ? cv : { id: cv.id, ...over[cv.id] })),
});

/** A client that serves scripted pages for ONE board and a permissive schema. */
function client(opts: {
  pages: Array<{ cursor: string | null; items: RawItem[] }>;
  meta?: BoardMeta[];
  board?: AgendaHistoryColumns;
  /** Override what the board CLAIMS to hold; defaults to what the pages actually serve. */
  itemsCount?: number | null;
}): AgendaHistoryClient {
  const board = opts.board ?? AGENDA_2026_HISTORY;
  const served = new Set(opts.pages.flatMap((page) => page.items.map((item) => item.id))).size;
  let index = 0;
  return {
    getSchema(): Promise<BoardMeta[]> {
      return Promise.resolve(
        opts.meta ?? [metaOf(board, { items_count: 'itemsCount' in opts ? opts.itemsCount : served })]
      );
    },
    query<T>(document: string): Promise<T> {
      const page = opts.pages[Math.min(index, opts.pages.length - 1)];
      index += 1;
      const payload = document.includes('next_items_page')
        ? { next_items_page: page }
        : { boards: [{ items_page: page }] };
      // The shape is the transport's, not ours; the reader validates it.
      return Promise.resolve(payload as T);
    },
  };
}

const lowFloor = (c: AgendaHistoryColumns): AgendaHistoryColumns => ({ ...c, minimumItems: 1 });
const BOARD = lowFloor(AGENDA_2026_HISTORY);

describe('readAgendaHistory', () => {
  it('reads a single page into training entries and join refs', async () => {
    const history = await readAgendaHistory(
      client({ pages: [{ cursor: null, items: [item('1', BOARD)] }], board: BOARD }),
      [BOARD]
    );

    expect(history.trainings).toHaveLength(1);
    expect(history.trainings[0].entry).toEqual({
      trainingItemId: '1',
      datum: '2026-01-01',
      trainerExternalIds: ['tr1'],
      themaExternalIds: ['th1'],
    });
    expect(history.trainings[0].ref.rawIeCode).toBe('IE1');
    expect(history.perBoard[0]).toMatchObject({ items: 1, pages: 1 });
  });

  it('follows the cursor across pages', async () => {
    const history = await readAgendaHistory(
      client({
        pages: [
          { cursor: 'c1', items: [item('1', BOARD)] },
          { cursor: null, items: [item('2', BOARD)] },
        ],
        board: BOARD,
      }),
      [BOARD]
    );

    expect(history.trainings.map((t) => t.entry.trainingItemId)).toEqual(['1', '2']);
    expect(history.perBoard[0].pages).toBe(2);
  });

  describe('empty values are normal; missing columns are drift', () => {
    it('accepts an undated, trainer-less, code-less training', async () => {
      const blank = item('1', BOARD, {
        [BOARD.datum]: { text: '' },
        [BOARD.ieCode]: { text: '   ' },
        [BOARD.trainerRelation]: { linked_item_ids: [] },
        [BOARD.themaRelation]: { linked_item_ids: [] },
      });

      const history = await readAgendaHistory(
        client({ pages: [{ cursor: null, items: [blank] }], board: BOARD }),
        [BOARD]
      );

      expect(history.trainings[0].entry).toMatchObject({
        datum: null,
        trainerExternalIds: [],
        themaExternalIds: [],
      });
      expect(history.trainings[0].ref.rawIeCode).toBeNull();
    });

    /**
     * The bevinding-4 failure mode at its most literal: Monday omits a column id it does
     * not recognise, so reading 2025 with the 2026 relation ids yields trainer-less
     * trainings and no error at all.
     */
    it('throws when the trainer relation column is absent from the response', async () => {
      const missing: RawItem = {
        id: '1',
        column_values: [
          { id: BOARD.datum, text: '2026-01-01' },
          { id: BOARD.ieCode, text: 'IE1' },
          { id: BOARD.themaRelation, linked_item_ids: ['th1'] },
        ],
      };

      await expect(
        readAgendaHistory(client({ pages: [{ cursor: null, items: [missing] }], board: BOARD }), [
          BOARD,
        ])
      ).rejects.toThrow(/board relation/);
    });

    it('throws when a relation column returns no linked_item_ids at all', async () => {
      const retyped = item('1', BOARD, { [BOARD.themaRelation]: { text: 'NLP' } });

      await expect(
        readAgendaHistory(client({ pages: [{ cursor: null, items: [retyped] }], board: BOARD }), [
          BOARD,
        ])
      ).rejects.toThrow(/board relation/);
    });

    it('throws when the date column is absent', async () => {
      const missing: RawItem = {
        id: '1',
        column_values: [
          { id: BOARD.ieCode, text: 'IE1' },
          { id: BOARD.trainerRelation, linked_item_ids: ['tr1'] },
          { id: BOARD.themaRelation, linked_item_ids: ['th1'] },
        ],
      };

      await expect(
        readAgendaHistory(client({ pages: [{ cursor: null, items: [missing] }], board: BOARD }), [
          BOARD,
        ])
      ).rejects.toThrow(/date column/);
    });
  });

  describe('refusing a partial or repeated read', () => {
    it('throws on an unreadable page rather than treating it as empty', async () => {
      const broken: AgendaHistoryClient = {
        getSchema: () => Promise.resolve([metaOf(BOARD, { items_count: 0 })]),
        query: <T,>() => Promise.resolve({ boards: [{ items_page: { nope: true } }] } as T),
      };

      await expect(readAgendaHistory(broken, [BOARD])).rejects.toThrow(/unreadable page/);
    });

    it('throws when Monday repeats a cursor', async () => {
      const looping: AgendaHistoryClient = {
        getSchema: () => Promise.resolve([metaOf(BOARD, { items_count: 0 })]),
        query: <T,>() =>
          Promise.resolve({
            boards: [{ items_page: { cursor: 'same', items: [] } }],
            next_items_page: { cursor: 'same', items: [] },
          } as T),
      };

      await expect(readAgendaHistory(looping, [BOARD])).rejects.toThrow(/repeated a pagination/);
    });

    /** A live board can shift an edited item onto two pages, doubling every count on it. */
    it('throws when the same item arrives twice', async () => {
      await expect(
        readAgendaHistory(
          client({
            pages: [
              { cursor: 'c1', items: [item('1', BOARD)] },
              { cursor: null, items: [item('1', BOARD)] },
            ],
            board: BOARD,
            itemsCount: 2,
          }),
          [BOARD]
        )
      ).rejects.toThrow(/duplicate item ids/);
    });

    /**
     * The floor cannot see this: 700 of 776 clears it comfortably and yields a history
     * short by 76 trainings with no error at all. The board already told us the number.
     */
    it('throws when the pages return fewer items than the board reports', async () => {
      await expect(
        readAgendaHistory(
          client({ pages: [{ cursor: null, items: [item('1', BOARD)] }], board: BOARD, itemsCount: 700 }),
          [BOARD]
        )
      ).rejects.toThrow(/fetched 1 unique items, items_count is 700/);
    });

    it('throws when the board cannot report its own size', async () => {
      await expect(
        readAgendaHistory(
          client({ pages: [{ cursor: null, items: [item('1', BOARD)] }], board: BOARD, itemsCount: null }),
          [BOARD]
        )
      ).rejects.toThrow(/cannot prove completeness/);
    });

    /**
     * A board answering with a handful of items is syntactically perfect and
     * semantically catastrophic — every pair it no longer mentions gets blanked.
     */
    it('throws when a board returns fewer items than its floor', async () => {
      const withFloor: AgendaHistoryColumns = { ...AGENDA_2026_HISTORY, minimumItems: 600 };

      await expect(
        readAgendaHistory(
          client({ pages: [{ cursor: null, items: [item('1', withFloor)] }], board: withFloor }),
          [withFloor]
        )
      ).rejects.toThrow(/below the floor/);
    });

    it('throws when a board is missing from the schema response', async () => {
      await expect(
        readAgendaHistory(client({ pages: [{ cursor: null, items: [] }], meta: [], board: BOARD }), [
          BOARD,
        ])
      ).rejects.toThrow(/not found/);
    });

    /** A repointed relation keeps its id AND its type; only the settings betray it. */
    it('throws when the trainer relation points at another board', async () => {
      const drifted = metaOf(BOARD);
      const repointed: BoardMeta = {
        ...drifted,
        columns: drifted.columns.map((c) =>
          c.id === BOARD.trainerRelation ? { ...c, settings_str: '{"boardIds":[999]}' } : c
        ),
      };

      await expect(
        readAgendaHistory(
          client({ pages: [{ cursor: null, items: [] }], meta: [repointed], board: BOARD }),
          [BOARD]
        )
      ).rejects.toThrow(/drift/i);
    });
  });

  it('refuses a pulse id seen on two different boards', async () => {
    const b2025 = lowFloor(AGENDA_2025_HISTORY);
    let call = 0;
    const twoBoards: AgendaHistoryClient = {
      getSchema: () =>
        Promise.resolve([metaOf(BOARD, { items_count: 1 }), metaOf(b2025, { items_count: 1 })]),
      query: <T,>(document: string) => {
        const columns = call === 0 ? BOARD : b2025;
        call += 1;
        return Promise.resolve({
          boards: [{ items_page: { cursor: null, items: [item('shared', columns)] } }],
        } as T);
      },
    };

    await expect(readAgendaHistory(twoBoards, [BOARD, b2025])).rejects.toThrow(
      /across boards.*duplicate/s
    );
  });
});

/**
 * The same reader over the real 756-item snapshot, replayed through a stub transport.
 * Skipped where `snapshots/` is absent, which is every fresh clone.
 */
const SNAPSHOT = join(process.cwd(), 'snapshots', 'monday', 'agenda-2026.json');

describe.skipIf(!existsSync(SNAPSHOT))('against the real Agenda 2026 snapshot', () => {
  interface SnapshotItem {
    id: string;
    column_values: Array<{ id: string; text?: string | null; linked_item_ids?: string[] }>;
  }
  const items: SnapshotItem[] = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));

  const serve = (columns: AgendaHistoryColumns): AgendaHistoryClient => ({
    getSchema: () => Promise.resolve([metaOf(columns, { items_count: items.length })]),
    query: <T,>() =>
      Promise.resolve({
        boards: [
          {
            items_page: {
              cursor: null,
              // Narrow to the requested ids, exactly as Monday would.
              items: items.map((i) => ({
                id: i.id,
                column_values: [
                  ...i.column_values.filter((c) =>
                    [
                      columns.datum,
                      columns.ieCode,
                      columns.trainerRelation,
                      columns.themaRelation,
                      columns.klantRelation,
                    ].includes(c.id)
                  ),
                  /**
                   * De snapshot is van 24 juli en de co-trainerkolom is op 21 augustus
                   * aangemaakt, dus hij staat er niet in. Een lege relatie is precies wat
                   * Monday teruggeeft voor een training zonder co-trainer, en dat is op dit
                   * moment ook elke training: ITG is nog niemand aan het verplaatsen.
                   */
                  ...(columns.coTrainerRelation === undefined
                    ? []
                    : [{ id: columns.coTrainerRelation, linked_item_ids: [] as string[] }]),
                ],
              })),
            },
          },
        ],
      } as T),
  });

  /**
   * The klant link on real data, because it is now load-bearing: it decides whether
   * trainings sharing an IE code are one session or an accidental collision. A snapshot
   * where it reads null everywhere would make every shared code look like a collision.
   */
  it('reads a klant on the real snapshot, not null', async () => {
    const history = await readAgendaHistory(serve(AGENDA_2026_HISTORY), [AGENDA_2026_HISTORY]);
    const withKlant = history.trainings.filter((t) => t.ref.clientKey !== null);

    expect(withKlant.length).toBeGreaterThan(history.trainings.length / 2);
  });

  it('reads all 756 trainings', async () => {
    const history = await readAgendaHistory(serve(AGENDA_2026_HISTORY), [AGENDA_2026_HISTORY]);

    expect(history.trainings).toHaveLength(756);
    expect(history.trainings.filter((t) => t.entry.trainerExternalIds.length > 0).length).toBeGreaterThan(
      400
    );
  });

  /**
   * The measured trap, reproduced end to end: the 2025 column ids find nothing on a 2026
   * board. Before this guard that produced trainer-less trainings and a silently smaller
   * corpus; now it is a refusal.
   */
  it('refuses the 2026 board read with the 2025 column ids', async () => {
    const wrongMap: AgendaHistoryColumns = {
      ...AGENDA_2025_HISTORY,
      boardId: AGENDA_2026_HISTORY.boardId,
      minimumItems: 1,
    };

    await expect(readAgendaHistory(serve(wrongMap), [wrongMap])).rejects.toThrow(
      /board relation|date column|IE-code/
    );
  });
});

/**
 * De co-trainerkolom, sinds 21-Aug-2026. Dit is het scenario dat stil misgaat: ITG haalt een
 * co-trainer uit de leadkolom, en zonder deze lezing telt die sessie niet meer mee voor hem —
 * zijn evaluatiecijfers zakken zonder dat er iets op een scherm verandert.
 */
describe('co-trainers in de evaluatiehistorie', () => {
  const CO = AGENDA_2026_HISTORY.coTrainerRelation ?? '';
  /** Dezelfde kolommen, maar zonder de ondergrens van 600 items voor één testitem. */
  const BOARD: AgendaHistoryColumns = { ...AGENDA_2026_HISTORY, minimumItems: 1 };

  const oneItem = (over: Record<string, Record<string, unknown>>): AgendaHistoryClient =>
    client({ pages: [{ cursor: null, items: [item('1', BOARD, over)] }], board: BOARD });

  it('kent de kolom, anders test de rest hieronder niets', () => {
    expect(CO).toBe('itg_cotrainers');
  });

  it('schrijft de sessie toe aan de lead én aan de co-trainer', async () => {
    const { trainings } = await readAgendaHistory(oneItem({ [CO]: { linked_item_ids: ['tr2'] } }), [
      BOARD,
    ]);
    expect(trainings[0]?.entry.trainerExternalIds).toEqual(['tr1', 'tr2']);
  });

  it('telt dezelfde persoon in beide kolommen één keer', async () => {
    const { trainings } = await readAgendaHistory(oneItem({ [CO]: { linked_item_ids: ['tr1'] } }), [
      BOARD,
    ]);
    expect(trainings[0]?.entry.trainerExternalIds).toEqual(['tr1']);
  });

  /**
   * Een hernoemde co-trainerkolom moet stuklopen. Monday laat een onbekend kolom-id weg, dus
   * stil doorgaan zou "er zijn geen co-trainers" opleveren — precies de plausibele nul die
   * niemand opmerkt.
   */
  it('werpt als de co-trainerkolom niet als relatie terugkomt', async () => {
    const broken = oneItem({ [CO]: { text: 'geen relatie meer' } });
    await expect(readAgendaHistory(broken, [BOARD])).rejects.toThrow(
      /itg_cotrainers/
    );
  });
});
