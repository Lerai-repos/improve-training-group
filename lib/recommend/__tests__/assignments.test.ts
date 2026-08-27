import { describe, expect, it } from 'vitest';

import {
  NO_ASSIGNMENTS,
  buildAgendaScan,
  buildAssignmentIndex,
  conflictsFor,
  countsFor,
  dayKeyOf,
  monthKeyOf,
  readAgendaScan,
} from '../assignments';

/**
 * Ported from two Airtable formula fields, read out of the base's metadata rather than
 * guessed:
 *
 *   Maandsleutel          = DATETIME_FORMAT(Datum, 'YYYY-MM')
 *   Opdrachten deze maand = occurrences of THIS TRAINING's month key in the trainer's roll-up
 *   Opdrachten dit jaar   = occurrences of its first four characters
 */

const rows = [
  { itemId: 'i1661', date: '2026-09-15', trainerItemIds: ['a', 'b'], times: null, client: null },
  { itemId: 'i5400', date: '2026-09-30', trainerItemIds: ['a'], times: null, client: null },
  { itemId: 'i6451', date: '2026-10-01', trainerItemIds: ['a'], times: null, client: null },
  { itemId: 'i2281', date: '2025-09-01', trainerItemIds: ['a'], times: null, client: null },
  { itemId: 'undated', date: null, trainerItemIds: ['a'], times: null, client: null },
];

describe('monthKeyOf', () => {
  it('takes the YYYY-MM prefix of a Monday date', () => {
    expect(monthKeyOf('2026-09-15')).toBe('2026-09');
    expect(monthKeyOf(' 2026-09-15 ')).toBe('2026-09');
  });

  /** A training with no date belongs to no month, and must not land in one. */
  it('returns null for anything that is not a date', () => {
    for (const value of [null, undefined, '', 'morgen', '15-09-2026']) {
      expect(monthKeyOf(value)).toBeNull();
    }
  });
});

describe('countsFor', () => {
  const index = buildAssignmentIndex(rows);

  /**
   * The distinction the formula settles: "deze maand" is the month of the TRAINING being
   * planned, not the current calendar month. Planning September in August must show
   * September's load.
   */
  it('counts the month of the training, whatever today is', () => {
    expect(countsFor(index, 'a', '2026-09')).toEqual({ thisMonth: 2, thisYear: 3 });
    expect(countsFor(index, 'a', '2026-10')).toEqual({ thisMonth: 1, thisYear: 3 });
  });

  it('counts the year of the training, not every year', () => {
    // Trainer `a` has one training in 2025; it must not inflate the 2026 total.
    expect(countsFor(index, 'a', '2025-09')).toEqual({ thisMonth: 1, thisYear: 1 });
  });

  it('counts each trainer on a shared training', () => {
    expect(countsFor(index, 'b', '2026-09')).toEqual({ thisMonth: 1, thisYear: 1 });
  });

  it('ignores trainings with no date', () => {
    // Five rows for `a`, but the undated one belongs to no month.
    expect(
      countsFor(index, 'a', '2026-09').thisYear + countsFor(index, 'a', '2025-09').thisYear
    ).toBe(4);
  });

  it('is zero for a trainer with nothing booked, and for a training with no date', () => {
    expect(countsFor(index, 'nobody', '2026-09')).toEqual(NO_ASSIGNMENTS);
    expect(countsFor(index, 'a', null)).toEqual(NO_ASSIGNMENTS);
  });
});

describe('readAgendaScan', () => {
  const page = (items: unknown[], cursor: string | null) => ({ cursor, items });

  it('follows the cursor and counts across pages', async () => {
    const documents: string[] = [];
    const client = {
      query: <T>(document: string): Promise<T> => {
        documents.push(document);
        const first = documents.length === 1;
        const body = first
          ? {
              boards: [
                {
                  items_page: page(
                    [
                      {
                        id: '1',
                        column_values: [
                          { id: 'datum_1', text: '2026-09-15' },
                          { id: 'rel', linked_item_ids: ['a'] },
                        ],
                      },
                    ],
                    'next'
                  ),
                },
              ],
            }
          : {
              next_items_page: page(
                [
                  {
                    id: '2',
                    column_values: [
                      { id: 'datum_1', text: '2026-09-20' },
                      { id: 'rel', linked_item_ids: [1234] },
                    ],
                  },
                ],
                null
              ),
            };
        return Promise.resolve(JSON.parse(JSON.stringify(body)));
      },
    };

    const scan = await readAgendaScan(client, {
      boardId: '5087396949',
      dateColumnId: 'datum_1',
      trainerColumnIds: ['rel'],
    });

    expect(countsFor(scan.workload, 'a', '2026-09').thisMonth).toBe(1);
    // Monday returns linked ids as numbers; the rest of the app speaks strings.
    expect(countsFor(scan.workload, '1234', '2026-09').thisMonth).toBe(1);
    expect(documents).toHaveLength(2);
    // The training's own month rides along, so the view never depends on a stored one.
    expect(scan.monthByItemId.get('1')).toBe('2026-09');
  });

  /**
   * The column ids travel with the call rather than living in module state — they differ
   * per Agenda board year, and shared mutable ids would let two concurrent runs read
   * each other's columns.
   */
  it('asks for the column ids it was given', async () => {
    let asked = '';
    await readAgendaScan(
      {
        query: <T>(document: string): Promise<T> => {
          asked = document;
          return Promise.resolve(
            JSON.parse(JSON.stringify({ boards: [{ items_page: page([], null) }] }))
          );
        },
      },
      { boardId: '1', dateColumnId: 'datum_x', trainerColumnIds: ['rel_y'] }
    );

    expect(asked).toContain('datum_x');
    expect(asked).toContain('rel_y');
  });

  /**
   * Fail closed. An empty index would let the run succeed and persist "0 opdrachten" for
   * every trainer — a number indistinguishable on screen from a genuinely quiet month.
   * A renamed column or a Monday outage has to surface as a retryable failure.
   */
  it('throws on an unreadable reply rather than reporting nobody is busy', async () => {
    await expect(
      readAgendaScan(
        { query: <T>(): Promise<T> => Promise.resolve(JSON.parse('{"nope":1}')) },
        { boardId: '1', dateColumnId: 'd', trainerColumnIds: ['r'] }
      )
    ).rejects.toThrow(/unreadable page/);
  });

  /**
   * The envelope failing closed is not enough: Monday OMITS a column it does not
   * recognise rather than erroring. A renamed date column drops every training out of
   * every month; a retyped relation returns no ids. Both come out as a plausible zero.
   */
  /**
   * `Bedrijf` is een MIRROR, en een mirror geeft `text: null` met de waarde in
   * `display_value`. Zonder dat fragment komt de klantnaam op élke rij leeg terug en
   * verliest het label stilzwijgend zijn halve nut — precies wat de trainingskop al
   * eerder overkwam.
   */
  it('leest de klantnaam uit display_value, niet uit text', async () => {
    const documents: string[] = [];
    const client = {
      query: <T>(document: string): Promise<T> => {
        documents.push(document);
        return Promise.resolve({
          boards: [
            {
              items_page: page(
                [
                  {
                    id: '1',
                    column_values: [
                      { id: 'datum_1', text: '2026-09-15' },
                      { id: 'rel', linked_item_ids: ['a'] },
                      { id: 'tijd', text: '09:30-12:30' },
                      { id: 'bedrijf', text: null, display_value: 'Probiblio' },
                    ],
                  },
                ],
                null
              ),
            },
          ],
        } as T);
      },
    };

    const scan = await readAgendaScan(client, {
      boardId: 'b',
      dateColumnId: 'datum_1',
      trainerColumnIds: ['rel'],
      timesColumnId: 'tijd',
      clientColumnId: 'bedrijf',
    });

    expect(documents[0]).toContain('... on MirrorValue { display_value }');
    expect(conflictsFor(scan, 'a', '2026-09-15', 'geen')).toEqual([
      { itemId: '1', client: 'Probiblio', times: '09:30-12:30' },
    ]);
  });

  /**
   * Anders dan de datum- en relatiekolom zijn dit decoratieve velden: een hernoemde
   * `Tijden` hoort een tijd te kosten, niet de hele scan — en daarmee de werklastkolommen
   * waar de klacht over ging.
   */
  it('overleeft een ontbrekende tijd- en klantkolom', async () => {
    const client = {
      query: <T>(): Promise<T> =>
        Promise.resolve({
          boards: [
            {
              items_page: page(
                [
                  {
                    id: '1',
                    column_values: [
                      { id: 'datum_1', text: '2026-09-15' },
                      { id: 'rel', linked_item_ids: ['a'] },
                    ],
                  },
                ],
                null
              ),
            },
          ],
        } as T),
    };

    const scan = await readAgendaScan(client, {
      boardId: 'b',
      dateColumnId: 'datum_1',
      trainerColumnIds: ['rel'],
      timesColumnId: 'weg',
      clientColumnId: 'ook-weg',
    });

    expect(conflictsFor(scan, 'a', '2026-09-15', 'geen')).toEqual([
      { itemId: '1', client: null, times: null },
    ]);
  });

  describe('schema drift in the columns themselves', () => {
    const reply = (columns: unknown[]) => ({
      boards: [{ items_page: { cursor: null, items: [{ id: '1', column_values: columns }] } }],
    });
    const scanWith = (columns: unknown[]) =>
      readAgendaScan(
        {
          query: <T>(): Promise<T> => Promise.resolve(JSON.parse(JSON.stringify(reply(columns)))),
        },
        { boardId: '1', dateColumnId: 'datum_1', trainerColumnIds: ['rel'] }
      );

    it('throws when the date column is missing', async () => {
      await expect(scanWith([{ id: 'rel', linked_item_ids: ['a'] }])).rejects.toThrow(
        /date column/
      );
    });

    it('throws when the relation is missing or is not a relation', async () => {
      await expect(scanWith([{ id: 'datum_1', text: '2026-09-15' }])).rejects.toThrow(
        /board relation/
      );
      await expect(
        scanWith([
          { id: 'datum_1', text: '2026-09-15' },
          { id: 'rel', text: 'Jeroen' },
        ])
      ).rejects.toThrow(/board relation/);
    });

    /** Empty is normal: a training with no date or no trainer yet is not schema drift. */
    it('accepts empty values', async () => {
      const result = await scanWith([
        { id: 'datum_1', text: null },
        { id: 'rel', linked_item_ids: [] },
      ]);
      expect(result.workload.size).toBe(0);
      // Scanned and monthless — a different fact from "not scanned".
      expect(result.monthByItemId.get('1')).toBeNull();
    });
  });

  /**
   * A repeated cursor would page over the same items forever, doubling every count in
   * them; running out of pages would cache a PARTIAL board as authoritative, quietly
   * understating everyone's workload.
   */
  it('refuses a repeated cursor', async () => {
    const body = {
      boards: [{ items_page: { cursor: 'same', items: [] } }],
      next_items_page: { cursor: 'same', items: [] },
    };
    await expect(
      readAgendaScan(
        { query: <T>(): Promise<T> => Promise.resolve(JSON.parse(JSON.stringify(body))) },
        { boardId: '1', dateColumnId: 'd', trainerColumnIds: ['r'] }
      )
    ).rejects.toThrow(/repeated a pagination cursor/);
  });

  it('refuses a partial index when the board never stops paging', async () => {
    let n = 0;
    await expect(
      readAgendaScan(
        {
          query: <T>(): Promise<T> => {
            n += 1;
            const body =
              n === 1
                ? { boards: [{ items_page: { cursor: `c${n}`, items: [] } }] }
                : { next_items_page: { cursor: `c${n}`, items: [] } };
            return Promise.resolve(JSON.parse(JSON.stringify(body)));
          },
        },
        { boardId: '1', dateColumnId: 'd', trainerColumnIds: ['r'] }
      )
    ).rejects.toThrow(/refusing a partial index/);
  });

  /**
   * A repeated CURSOR is one failure; a repeated ITEM is another. Monday paginates a
   * LIVE board, so an item edited mid-scan can shift and appear on two consecutive
   * pages — and counting that training twice for every trainer on it would cache an
   * inflated workload as authoritative for five minutes.
   */
  it('refuses when the same training appears on two pages', async () => {
    const item = (id: string) => ({
      id,
      column_values: [
        { id: 'd', text: '2026-09-15' },
        { id: 'r', linked_item_ids: ['a'] },
      ],
    });
    let n = 0;
    await expect(
      readAgendaScan(
        {
          query: <T>(): Promise<T> => {
            n += 1;
            const body =
              n === 1
                ? { boards: [{ items_page: { cursor: 'p2', items: [item('1'), item('2')] } }] }
                : { next_items_page: { cursor: null, items: [item('2'), item('3')] } };
            return Promise.resolve(JSON.parse(JSON.stringify(body)));
          },
        },
        { boardId: '1', dateColumnId: 'd', trainerColumnIds: ['r'] }
      )
    ).rejects.toThrow(/duplicate item ids/);
  });
});

describe('dagbotsingen', () => {
  const rows = [
    {
      itemId: 'deze',
      date: '2026-09-15',
      trainerItemIds: ['t1'],
      times: '13:00-16:00',
      client: 'Calduran',
    },
    {
      itemId: 'ander',
      date: '2026-09-15',
      trainerItemIds: ['t1', 't2'],
      times: '09:30-12:30',
      client: 'Probiblio',
    },
    {
      itemId: 'andere-dag',
      date: '2026-09-16',
      trainerItemIds: ['t1'],
      times: '09:30-12:30',
      client: 'Gemeente Gouda',
    },
  ];

  it('indexeert per trainer per dag, met klant en tijd', () => {
    const scan = buildAgendaScan(rows);

    expect(conflictsFor(scan, 't2', '2026-09-15', 'deze')).toEqual([
      { itemId: 'ander', client: 'Probiblio', times: '09:30-12:30' },
    ]);
  });

  /**
   * Zonder deze uitsluiting botst elke gekoppelde trainer met de sessie die de planner op
   * dat moment vóór zich heeft — een waarschuwing op precies de verkeerde rijen.
   */
  it('sluit de training zelf uit', () => {
    const scan = buildAgendaScan(rows);

    const uit = conflictsFor(scan, 't1', '2026-09-15', 'deze');

    expect(uit.map((c) => c.itemId)).toEqual(['ander']);
  });

  it('telt een andere dag niet mee', () => {
    const scan = buildAgendaScan(rows);

    expect(conflictsFor(scan, 't1', '2026-09-17', 'deze')).toEqual([]);
  });

  /** Een training zonder datum hoort nergens; hij mag geen enkele dag vullen. */
  it('negeert een training zonder datum', () => {
    const scan = buildAgendaScan([
      { itemId: 'x', date: null, trainerItemIds: ['t1'], times: null, client: null },
    ]);

    expect(scan.dayIndex.get('t1')).toBeUndefined();
    expect(scan.dateByItemId.get('x')).toBeNull();
  });

  /**
   * Gescand-maar-datumloos en nooit-gescand moeten uit elkaar te houden zijn, net als bij
   * de maand: het eerste weet dat er geen dag is, het tweede weet niets.
   */
  it('houdt "gescand zonder datum" en "niet gescand" uit elkaar', () => {
    const scan = buildAgendaScan([
      { itemId: 'x', date: null, trainerItemIds: [], times: null, client: null },
    ]);

    expect(scan.dateByItemId.has('x')).toBe(true);
    expect(scan.dateByItemId.has('nooit-gezien')).toBe(false);
  });

  it('leest de dag uit een Monday-datumcel', () => {
    expect(dayKeyOf('2026-09-15')).toBe('2026-09-15');
    expect(dayKeyOf('2026-09')).toBeNull();
    expect(dayKeyOf(null)).toBeNull();
  });
});
