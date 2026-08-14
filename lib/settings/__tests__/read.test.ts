import { describe, expect, it, vi } from 'vitest';

import { readSettings, SETTINGS_EXPECTED_COLUMNS } from '../read';

import type { BoardMeta, MondayGraphQLClient } from '@lib/monday/graphql-client';

const BOARD = '1234567890';
const NOTITIES = 'group_notities';
const SETTINGS = 'group_instellingen';

interface Row {
  id: string;
  name: string;
  updated_at: string;
  group: { id: string };
  column_values: Array<{ id: string; text: string | null }>;
}

const row = (id: string, name: string, value: string, groupId = SETTINGS): Row => ({
  id,
  name,
  updated_at: '2026-08-13T00:00:00Z',
  group: { id: groupId },
  column_values: [{ id: 'itg_waarde', text: value }],
});

const COMPLETE: Row[] = [
  row('1', 'HQ ADRES', 'Wolvenplein 25, Utrecht'),
  row('2', 'REISTARIEF TRAINERS', '0.23'),
  row('3', 'REISTARIEF HQ', '0.45'),
  row('4', 'REISTIJD DREMPEL', '90'),
  row('5', 'REISTIJD VERGOEDING', '1'),
  row('6', 'TARIEF 2020 - 2024', '88'),
  row('7', 'TARIEF 2024 - HEDEN', '84'),
];

const board = (over: Partial<BoardMeta> = {}): BoardMeta => ({
  id: BOARD,
  name: 'Instellingen',
  groups: [
    { id: SETTINGS, title: 'Instellingen' },
    { id: NOTITIES, title: 'Notities' },
  ],
  columns: SETTINGS_EXPECTED_COLUMNS.map((c) => ({
    id: c.id,
    title: c.id,
    type: c.type,
    settings_str: null,
  })),
  items_count: 7,
  ...over,
});

function stubClient(rows: Row[], meta: BoardMeta = board()): MondayGraphQLClient {
  return {
    query: vi.fn(),
    preflight: vi.fn(),
    getSchema: vi.fn(async () => [meta]),
    fetchBoardItems: vi.fn(async () => rows),
    lastReportedVersion: () => null,
  } as unknown as MondayGraphQLClient;
}

const config = { boardId: BOARD, notitiesGroupId: NOTITIES };

describe('readSettings', () => {
  it('reads the seven rows into config rows and rate cents', async () => {
    const result = await readSettings(stubClient(COMPLETE), config);

    expect(result.appRows).toContainEqual({ key: 'HQ_ADRES', value: 'Wolvenplein 25, Utrecht' });
    expect(result.appRows).toContainEqual({
      key: 'TRAVEL_RATE_TRAINER_CENTS_PER_KM',
      value: '23',
    });
    expect(result.rateCents.get('2020-2024')).toBe(8800);
    expect(result.rateCents.get('2024-heden')).toBe(8400);
  });

  /**
   * `fetchBoardItems` derives its AFTER inventory from the fetched items, so the
   * projection has to carry `updated_at` or every row compares as changed and every
   * read fails coherence. A total outage caused by an omitted field — asserted here so
   * the projection cannot be "tidied".
   */
  it('asks for id, updated_at and the item group', async () => {
    const client = stubClient(COMPLETE);
    await readSettings(client, config);

    const [, fields] = vi.mocked(client.fetchBoardItems).mock.calls[0];
    expect(fields).toContain('updated_at');
    expect(fields).toContain('group');
    expect(fields).toContain('itg_waarde');
  });

  it('passes items_count through, so completeness is actually proved', async () => {
    const client = stubClient(COMPLETE);
    await readSettings(client, config);

    const [boardId, , itemsCount] = vi.mocked(client.fetchBoardItems).mock.calls[0];
    expect(boardId).toBe(BOARD);
    expect(itemsCount).toBe(7);
  });

  it('throws when the board is not there at all', async () => {
    const client = stubClient(COMPLETE);
    vi.mocked(client.getSchema).mockResolvedValue([]);

    await expect(readSettings(client, config)).rejects.toThrow(/Instellingen/);
  });

  it('throws when a required column is missing or retyped', async () => {
    const retyped = board({
      columns: [
        { id: 'itg_waarde', title: 'Waarde', type: 'numbers', settings_str: null },
        { id: 'itg_categorie', title: 'Categorie', type: 'status', settings_str: null },
        { id: 'itg_omschrijving', title: 'Omschrijving', type: 'text', settings_str: null },
      ],
    });

    await expect(readSettings(stubClient(COMPLETE, retyped), config)).rejects.toThrow();
  });

  /**
   * On a board everyone can edit, someone adding a helper column is ordinary. Taking
   * the recommendation engine down for it would not be.
   */
  it('ignores unrelated extra columns', async () => {
    const extra = board({
      columns: [
        ...board().columns,
        { id: 'text_helper', title: 'Notities van Dirkje', type: 'text', settings_str: null },
      ],
    });

    await expect(readSettings(stubClient(COMPLETE, extra), config)).resolves.toBeDefined();
  });

  it('throws when the pinned Notities group is not on this board', async () => {
    const noGroup = board({ groups: [{ id: SETTINGS, title: 'Instellingen' }] });

    await expect(readSettings(stubClient(COMPLETE, noGroup), config)).rejects.toThrow(/Notities/);
  });

  describe('notes', () => {
    /**
     * The ordering problem this whole rule exists for: Monday creates the item BEFORE
     * anyone can set a column on it. A note therefore exists, for a few seconds, as an
     * unknown non-blank name with no category — and a strict reader would throw,
     * install the failure sentinel, and carry a retrying job to FOUT. For adding a note.
     */
    it('ignores a brand-new note that has no category yet', async () => {
      const rows = [...COMPLETE, row('8', 'even opletten hier', '', NOTITIES)];

      await expect(readSettings(stubClient(rows, board({ items_count: 8 })), config)).resolves
        .toBeDefined();
    });

    it('throws on an unknown name OUTSIDE the Notities group', async () => {
      const rows = [...COMPLETE, row('8', 'even opletten hier', '')];

      await expect(
        readSettings(stubClient(rows, board({ items_count: 8 })), config)
      ).rejects.toThrow(/even opletten hier/);
    });

    /**
     * Moving a real setting into Notities would otherwise be a silent delete that
     * leaves the row visibly on the board.
     */
    it('throws when a KNOWN key is parked in the Notities group', async () => {
      const rows = [
        ...COMPLETE.filter((r) => r.name !== 'HQ ADRES'),
        row('1', 'HQ ADRES', 'Wolvenplein 25, Utrecht', NOTITIES),
      ];

      await expect(readSettings(stubClient(rows, board()), config)).rejects.toThrow(/HQ ADRES/);
    });

    /** The group id is per board, so a different board's notes are judged by its own. */
    it('recognises a different board’s Notities group id', async () => {
      const other = 'group_anders';
      const meta = board({
        groups: [
          { id: SETTINGS, title: 'Instellingen' },
          { id: other, title: 'Notities' },
        ],
        items_count: 8,
      });
      const rows = [...COMPLETE, row('8', 'losse notitie', '', other)];

      await expect(
        readSettings(stubClient(rows, meta), { boardId: BOARD, notitiesGroupId: other })
      ).resolves.toBeDefined();
    });
  });

  it('throws on a duplicate key — two rows disagreeing is worse than none', async () => {
    const rows = [...COMPLETE, row('8', 'REISTARIEF TRAINERS', '0.30')];

    await expect(
      readSettings(stubClient(rows, board({ items_count: 8 })), config)
    ).rejects.toThrow(/REISTARIEF TRAINERS/);
  });

  it('throws on a duplicate tariff row too', async () => {
    const rows = [...COMPLETE, row('8', 'TARIEF 2020 - 2024', '90')];

    await expect(
      readSettings(stubClient(rows, board({ items_count: 8 })), config)
    ).rejects.toThrow(/TARIEF 2020 - 2024/);
  });

  it('throws on a malformed value rather than skipping the row', async () => {
    const rows = COMPLETE.map((r) =>
      r.name === 'REISTARIEF TRAINERS' ? row(r.id, r.name, 'abc') : r
    );

    await expect(readSettings(stubClient(rows), config)).rejects.toThrow();
  });

  it('lets a read failure escape — never an empty result', async () => {
    const client = stubClient(COMPLETE);
    vi.mocked(client.fetchBoardItems).mockRejectedValue(new Error('Monday 502'));

    await expect(readSettings(client, config)).rejects.toThrow(/502/);
  });

  /**
   * The board BEFORE the migration, asserted as a property rather than assumed: deploy
   * ③ ships this reader while production still has seven rows and no dropdown, so any
   * change that made the column mandatory would be a total outage on arrival.
   */
  it('reads a board without the Groepen column exactly as before', async () => {
    const client = stubClient(COMPLETE);
    const result = await readSettings(client, config);

    const [, fields] = vi.mocked(client.fetchBoardItems).mock.calls[0];
    expect(fields).not.toContain('itg_groepen');
    expect(client.query).not.toHaveBeenCalled();
    expect(result.appRows.some((r) => r.key === 'RECOMMENDABLE_TRAINER_GROUPS')).toBe(false);
    expect(result.emptyGroupSelection).toBe(false);
  });
});

// --- fase 2a: the TRAINERGROEPEN row and its dropdown ---

const GROEPEN = 'itg_groepen';

/** As Monday's typed `settings.labels` returns them: `id` is an Int. */
const LABELS = [
  { id: 1, label: 'Topics — topics' },
  { id: 2, label: 'Nieuwe groep — nieuwe_groep__1' },
];

const withGroepenColumn = (over: Partial<BoardMeta> = {}): BoardMeta =>
  board({
    columns: [
      ...board().columns,
      { id: GROEPEN, title: 'Groepen', type: 'dropdown', settings_str: null },
    ],
    items_count: 8,
    ...over,
  });

/**
 * The selection as `DropdownValue.values` returns it: `id` is a GraphQL `ID`, so it
 * arrives as a STRING while the labels above carry numbers. Keeping the two shapes
 * apart is the point — a stub that used one everywhere would hide the mismatch.
 */
const groepenRow = (selected: string[], waarde = ''): Row =>
  ({
    id: '8',
    name: 'TRAINERGROEPEN',
    updated_at: '2026-08-13T00:00:00Z',
    group: { id: SETTINGS },
    column_values: [
      { id: 'itg_waarde', text: waarde },
      { id: GROEPEN, text: 'whatever', values: selected.map((id) => ({ id, label: 'x' })) },
    ],
  }) as unknown as Row;

function stubWithGroepen(
  rows: Row[],
  labels: Array<{ id: number | string; label: string; is_deactivated?: boolean }> = LABELS,
  meta: BoardMeta = withGroepenColumn()
): MondayGraphQLClient {
  const client = stubClient(rows, meta);
  vi.mocked(client.query).mockResolvedValue({
    boards: [{ columns: [{ settings: { labels } }] }],
  });
  return client;
}

describe('readSettings — TRAINERGROEPEN', () => {
  it('resolves the selection from the dropdown, not from Waarde', async () => {
    const rows = [...COMPLETE, groepenRow(['1', '2'])];

    const result = await readSettings(stubWithGroepen(rows), config);

    expect(result.appRows).toContainEqual({
      key: 'RECOMMENDABLE_TRAINER_GROUPS',
      value: 'topics,nieuwe_groep__1',
    });
    expect(result.emptyGroupSelection).toBe(false);
  });

  /**
   * The shape mismatch the whole `String(id)` rule exists for: the labels come back as
   * numbers and the selection as strings. If either side is keyed on the raw value the
   * lookup misses and the board reads as "nothing selected" — an empty eligibility set
   * that silently defers to the environment instead of failing.
   */
  it('matches string selection ids against numeric label ids', async () => {
    const rows = [...COMPLETE, groepenRow(['2'])];

    const result = await readSettings(stubWithGroepen(rows), config);

    expect(result.appRows).toContainEqual({
      key: 'RECOMMENDABLE_TRAINER_GROUPS',
      value: 'nieuwe_groep__1',
    });
  });

  it('asks for the dropdown column once it exists', async () => {
    const client = stubWithGroepen([...COMPLETE, groepenRow(['1', '2'])]);
    await readSettings(client, config);

    const [, fields] = vi.mocked(client.fetchBoardItems).mock.calls[0];
    expect(fields).toContain('itg_groepen');
    expect(fields).toContain('DropdownValue');
  });

  /**
   * Someone who types the groups into `Waarde` has edited the board and expects an
   * effect. Ignoring that cell would drop the value, read the selection as empty, and
   * answer from the environment — a change with no result and no explanation.
   */
  it('throws when Waarde is filled in instead of Groepen', async () => {
    const rows = [...COMPLETE, groepenRow(['1'], 'topics')];

    await expect(readSettings(stubWithGroepen(rows), config)).rejects.toThrow(/Waarde/);
  });

  it('omits the row and flags it when nothing is selected', async () => {
    const rows = [...COMPLETE, groepenRow([])];

    const result = await readSettings(stubWithGroepen(rows), config);

    expect(result.appRows.some((r) => r.key === 'RECOMMENDABLE_TRAINER_GROUPS')).toBe(false);
    expect(result.emptyGroupSelection).toBe(true);
  });

  it('throws on two TRAINERGROEPEN rows', async () => {
    const rows = [...COMPLETE, groepenRow(['1']), { ...groepenRow(['2']), id: '9' }];

    await expect(
      readSettings(stubWithGroepen(rows, LABELS, withGroepenColumn({ items_count: 9 })), config)
    ).rejects.toThrow(/TRAINERGROEPEN/);
  });

  it('still throws when the row is parked in Notities', async () => {
    const rows = [...COMPLETE, { ...groepenRow(['1']), group: { id: NOTITIES } }];

    await expect(readSettings(stubWithGroepen(rows), config)).rejects.toThrow(/TRAINERGROEPEN/);
  });

  describe('identity', () => {
    const pinned = new Map([
      ['1', 'topics'],
      ['2', 'nieuwe_groep__1'],
    ]);

    /**
     * With the map pinned, the label is display only. Renaming one — even to something
     * carrying a different group id — must change nothing at all.
     */
    it('ignores the label text when the map is pinned', async () => {
      const renamed = [
        { id: 1, label: 'Vaste pool — nieuwe_groep__1' },
        { id: 2, label: 'Nieuwe groep — nieuwe_groep__1' },
      ];
      const rows = [...COMPLETE, groepenRow(['1'])];

      const result = await readSettings(stubWithGroepen(rows, renamed), {
        ...config,
        groepenOptions: pinned,
      });

      expect(result.appRows).toContainEqual({
        key: 'RECOMMENDABLE_TRAINER_GROUPS',
        value: 'topics',
      });
    });

    /**
     * Without a pinned map the labels ARE the identity, so their consistency is the only
     * thing standing between a swapped suffix and a silently different eligibility set.
     */
    it('refuses an incoherent label set while deriving', async () => {
      const swapped = [
        { id: 1, label: 'Topics — nieuwe_groep__1' },
        { id: 2, label: 'Nieuwe groep — nieuwe_groep__1' },
      ];
      const rows = [...COMPLETE, groepenRow(['1'])];

      await expect(readSettings(stubWithGroepen(rows, swapped), config)).rejects.toThrow(
        /nieuwe_groep__1/
      );
    });

    /**
     * A pinned map is a code constant: it still contains the option id long after the
     * label is deactivated, so it cannot tell retired from live on its own. Written
     * WITH the pinned map, so the test fails unless activeness is read from the board.
     */
    it('throws when a selected option has been deactivated', async () => {
      const retired = [LABELS[0], { ...LABELS[1], is_deactivated: true }];
      const rows = [...COMPLETE, groepenRow(['2'])];

      await expect(
        readSettings(stubWithGroepen(rows, retired), { ...config, groepenOptions: pinned })
      ).rejects.toThrow(/gedeactiveerd/);
    });

    /**
     * The other half of that rule: retiring an option NOBODY selected is housekeeping,
     * and stopping every recommendation for it would be a false alarm on the engine path.
     */
    it('tolerates an unselected deactivated option', async () => {
      const retired = [LABELS[0], { ...LABELS[1], is_deactivated: true }];
      const rows = [...COMPLETE, groepenRow(['1'])];

      await expect(
        readSettings(stubWithGroepen(rows, retired), { ...config, groepenOptions: pinned })
      ).resolves.toBeDefined();
    });

    it('throws when the option list cannot be read at all', async () => {
      const client = stubWithGroepen([...COMPLETE, groepenRow(['1'])]);
      vi.mocked(client.query).mockResolvedValue({ boards: [] });

      await expect(readSettings(client, config)).rejects.toThrow(/Groepen/);
    });
  });
});
