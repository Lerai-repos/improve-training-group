import { describe, expect, it, vi } from 'vitest';

import { groepenKeyPrefix, provisionGroepselectie } from '../provision-groepen';
import { SETTINGS_EXPECTED_COLUMNS } from '../read';

import type { MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { MondayMutationClient } from '@lib/monday/mutate';

const BOARD = '5102171946';
const NOTITIES = 'group_notities';
const SETTINGS = 'group_instellingen';
const SELECTIE = 'group_selectie';

const TITLES = new Map([
  ['topics', 'Topics'],
  ['nieuwe_groep__1', 'Nieuwe groep'],
]);

const SELECTION = ['topics', 'nieuwe_groep__1'];

interface Label {
  id: number;
  label: string;
  is_deactivated?: boolean;
}

interface Item {
  id: string;
  name: string;
  groupId: string;
  waarde: string;
  selected: number[];
}

const SEVEN: Array<[string, string]> = [
  ['HQ ADRES', 'Wolvenplein 25, Utrecht'],
  ['REISTARIEF TRAINERS', '0.23'],
  ['REISTARIEF HQ', '0.45'],
  ['REISTIJD DREMPEL', '90'],
  ['REISTIJD VERGOEDING', '1'],
  ['TARIEF 2020 - 2024', '88'],
  ['TARIEF 2024 - HEDEN', '84'],
];

/**
 * A board that actually changes when it is written to.
 *
 * The invariants under test are about SEQUENCE — create the column, then read the ids it
 * was given, then create the row referring to them — so a set of independent stubs would
 * verify the calls rather than the outcome, which is the half that has ever gone wrong.
 */
function fakeBoard(
  options: {
    labels?: Label[] | null;
    row?: { waarde?: string; selected: number[] } | null;
    columnType?: string;
    boardId?: string;
  } = {}
) {
  const boardId = options.boardId ?? BOARD;
  const hasColumn = options.labels !== undefined && options.labels !== null;
  const state = {
    labels: options.labels ?? null,
    columnType: options.columnType ?? 'dropdown',
    hasColumn,
    groups: [
      { id: SETTINGS, title: 'Instellingen' },
      { id: NOTITIES, title: 'Notities' },
    ],
    items: SEVEN.map(([name, waarde], i) => ({
      id: String(i + 1),
      name,
      groupId: SETTINGS,
      waarde,
      selected: [] as number[],
    })) as Item[],
    keys: [] as string[],
    mutations: [] as string[],
  };

  if (options.row) {
    state.groups.push({ id: SELECTIE, title: 'Groepselectie' });
    state.items.push({
      id: '8',
      name: 'TRAINERGROEPEN',
      groupId: SELECTIE,
      waarde: options.row.waarde ?? '',
      selected: options.row.selected,
    });
  }

  const columns = () => [
    ...SETTINGS_EXPECTED_COLUMNS.map((c) => ({
      id: c.id,
      title: c.id,
      type: c.type,
      settings_str: null,
    })),
    ...(state.hasColumn
      ? [{ id: 'itg_groepen', title: 'Groepen', type: state.columnType, settings_str: null }]
      : []),
  ];

  const read = {
    query: vi.fn(async () => ({
      boards: [{ columns: [{ settings: { labels: state.labels ?? [] } }] }],
    })),
    preflight: vi.fn(),
    getSchema: vi.fn(async () => [
      {
        id: boardId,
        name: 'Instellingen',
        groups: state.groups,
        columns: columns(),
        items_count: state.items.length,
      },
    ]),
    fetchBoardItems: vi.fn(async () =>
      state.items.map((item) => ({
        id: item.id,
        name: item.name,
        updated_at: '2026-08-14T00:00:00Z',
        group: { id: item.groupId },
        column_values: [
          { id: 'itg_waarde', text: item.waarde },
          {
            id: 'itg_groepen',
            text: '',
            values: item.selected.map((id) => ({ id: String(id), label: 'x' })),
          },
        ],
      }))
    ),
    lastReportedVersion: () => null,
  } as unknown as MondayGraphQLClient;

  const write: MondayMutationClient = {
    mutate: vi.fn(async (document: string, variables?: Record<string, unknown>, opts?) => {
      state.keys.push(opts?.idempotencyKey ?? '(none)');

      if (document.includes('create_dropdown_column')) {
        state.mutations.push('column');
        state.hasColumn = true;
        const defaults = variables?.defaults as { labels: Array<{ label: string }> };
        state.labels = defaults.labels.map((l, i) => ({ id: i + 1, label: l.label }));
        return { create_dropdown_column: { id: 'itg_groepen' } };
      }
      if (document.includes('create_group')) {
        state.mutations.push('group');
        state.groups.push({ id: SELECTIE, title: 'Groepselectie' });
        return { create_group: { id: SELECTIE } };
      }
      if (document.includes('create_item')) {
        state.mutations.push('item');
        const values = JSON.parse(String(variables?.values)) as {
          itg_groepen: { ids: number[] };
        };
        state.items.push({
          id: '8',
          name: String(variables?.name),
          groupId: String(variables?.group),
          waarde: '',
          selected: values.itg_groepen.ids,
        });
        return { create_item: { id: '8' } };
      }
      throw new Error(`unexpected mutation: ${document}`);
    }) as MondayMutationClient['mutate'],
  };

  return { read, write, state };
}

const deps = (fake: ReturnType<typeof fakeBoard>, over: Record<string, unknown> = {}) => ({
  read: fake.read,
  write: fake.write,
  boardId: BOARD,
  notitiesGroupId: NOTITIES,
  keyPrefix: `groepen:${BOARD}`,
  apply: true,
  selection: SELECTION,
  titles: TITLES,
  ...over,
});

const LIVE: Label[] = [
  { id: 1, label: 'Topics — topics' },
  { id: 2, label: 'Nieuwe groep — nieuwe_groep__1' },
];

describe('provisionGroepselectie', () => {
  it('builds the column, its options, the group and the row', async () => {
    const fake = fakeBoard();

    const result = await provisionGroepselectie(deps(fake));

    expect(fake.state.mutations).toEqual(['column', 'group', 'item']);
    expect(result.optionMap).toEqual(
      new Map([
        ['1', 'topics'],
        ['2', 'nieuwe_groep__1'],
      ])
    );
    expect(fake.state.items.at(-1)).toMatchObject({ name: 'TRAINERGROEPEN', selected: [1, 2] });
  });

  /**
   * The selection travels INSIDE the create. A row that appears first and is filled in
   * afterwards is visible, briefly, with nothing selected — which the engine reads as a
   * config error, and which nothing here could distinguish from someone clearing it.
   */
  it('never creates the row without its selection', async () => {
    const fake = fakeBoard();
    await provisionGroepselectie(deps(fake));

    const [, variables] = vi
      .mocked(fake.write.mutate)
      .mock.calls.find(([doc]) => doc.includes('create_item'))!;
    expect(JSON.parse(String(variables?.values)).itg_groepen).toEqual({ ids: [1, 2] });
  });

  it('does nothing on a second run', async () => {
    const fake = fakeBoard();
    await provisionGroepselectie(deps(fake));
    fake.state.mutations.length = 0;

    const result = await provisionGroepselectie(deps(fake));

    expect(fake.state.mutations).toEqual([]);
    expect(result.optionMap.size).toBe(2);
  });

  it('writes nothing at all on a dry run', async () => {
    const fake = fakeBoard();

    await provisionGroepselectie(deps(fake, { apply: false }));

    expect(fake.state.mutations).toEqual([]);
  });

  /**
   * `instellingen:create --dry-run` has no board yet — `ensureBoard` hands back a
   * synthetic id — so every query against it fails. Describing what WOULD be built is the
   * entire value of that preview, and it must not die at the last step.
   *
   * Deliberately not inferred from "board not found": on the migration command an
   * unreadable board is a typo'd id and still has to be reported.
   */
  it('describes a board that does not exist yet instead of querying it', async () => {
    const fake = fakeBoard();
    vi.mocked(fake.read.getSchema).mockResolvedValue([]);
    const lines: string[] = [];

    const result = await provisionGroepselectie(
      deps(fake, {
        apply: false,
        plannedBoard: true,
        boardId: '(dry-run)',
        log: (line: string) => lines.push(line),
      })
    );

    expect(result.optionMap.size).toBe(0);
    expect(fake.state.mutations).toEqual([]);
    expect(lines.join(' ')).toContain('TRAINERGROEPEN');
  });

  it('still refuses an unreadable board when it is supposed to exist', async () => {
    const fake = fakeBoard();
    vi.mocked(fake.read.getSchema).mockResolvedValue([]);

    await expect(provisionGroepselectie(deps(fake, { apply: false }))).rejects.toThrow();
  });

  /**
   * `RECOMMENDABLE_TRAINER_GROUPS=topics,topics` survives the env parser and the schema
   * intact. Sent on as `{ids:[1,1]}` Monday stores ONE selection, so a length comparison
   * fails against a row that has just been created successfully — and every later run
   * then refuses it as "a different selection". A board nobody can migrate without
   * editing it by hand.
   */
  it('deduplicates the seed before writing and comparing', async () => {
    const fake = fakeBoard();

    const result = await provisionGroepselectie(
      deps(fake, { selection: ['topics', 'topics', 'nieuwe_groep__1'] })
    );

    expect(fake.state.items.at(-1)?.selected).toEqual([1, 2]);
    expect(result.optionMap.size).toBe(2);
  });

  it('treats a repeated seed as equal to the selection already on the board', async () => {
    const fake = fakeBoard({ labels: LIVE, row: { selected: [1] } });

    await expect(
      provisionGroepselectie(deps(fake, { selection: ['topics', 'topics'] }))
    ).resolves.toBeDefined();
  });

  /**
   * Monday caches an idempotency key for 30 minutes, and this command is deliberately
   * run against production AND the isolated preview board. Keyed on the operation alone,
   * the preview's mutation would replay the production response: reported as success,
   * having changed nothing.
   */
  it('scopes every idempotency key to the board', async () => {
    const PREVIEW = '5101664426';
    // Derived, not hand-written per call: a test that passed two different prefixes in
    // would be checking its own setup rather than whether callers can get this wrong.
    expect(groepenKeyPrefix(BOARD)).toContain(BOARD);
    expect(groepenKeyPrefix(PREVIEW)).not.toBe(groepenKeyPrefix(BOARD));

    const production = fakeBoard();
    const preview = fakeBoard({ boardId: PREVIEW });

    await provisionGroepselectie(deps(production, { keyPrefix: groepenKeyPrefix(BOARD) }));
    await provisionGroepselectie(
      deps(preview, { boardId: PREVIEW, keyPrefix: groepenKeyPrefix(PREVIEW) })
    );

    // Every key carries the prefix through, so scoping the prefix scopes all of them.
    expect(production.state.keys.every((k) => k.startsWith(groepenKeyPrefix(BOARD)))).toBe(true);
    expect(production.state.keys.filter((k) => preview.state.keys.includes(k))).toEqual([]);
  });

  describe('states it refuses rather than repairs', () => {
    /**
     * A selection is an item value, and item values have no revision or CAS. Filling in
     * an empty row is therefore a blind overwrite of whatever someone was in the middle
     * of choosing — and the read-back would confirm only our own write.
     */
    it('refuses a row that exists with nothing selected', async () => {
      const fake = fakeBoard({ labels: LIVE, row: { selected: [] } });

      await expect(provisionGroepselectie(deps(fake))).rejects.toThrow(/niets geselecteerd/);
      expect(fake.state.mutations).toEqual([]);
    });

    it('refuses a row that already holds a different selection', async () => {
      const fake = fakeBoard({ labels: LIVE, row: { selected: [1] } });

      await expect(provisionGroepselectie(deps(fake))).rejects.toThrow(/andere selectie/);
      expect(fake.state.mutations).toEqual([]);
    });

    /**
     * The blind spot that makes the extra query necessary: an item reports only the
     * options it has SELECTED, so with one group chosen the read-back is perfectly happy
     * while the other priceable group has been deleted and nobody can pick it.
     */
    it('refuses a missing option even though the selection reads back fine', async () => {
      const fake = fakeBoard({
        labels: [LIVE[0]],
        row: { selected: [1] },
      });

      await expect(
        provisionGroepselectie(deps(fake, { selection: ['topics'] }))
      ).rejects.toThrow(/nieuwe_groep__1/);
    });

    it('refuses an unexpected ACTIVE option someone added', async () => {
      const fake = fakeBoard({
        labels: [...LIVE, { id: 9, label: 'Acteurs — acteurs' }],
        row: { selected: [1, 2] },
      });

      await expect(provisionGroepselectie(deps(fake))).rejects.toThrow(/acteurs/);
    });

    it('refuses when an expected option has been deactivated', async () => {
      const fake = fakeBoard({
        labels: [LIVE[0], { ...LIVE[1], is_deactivated: true }],
        row: { selected: [1] },
      });

      await expect(provisionGroepselectie(deps(fake))).rejects.toThrow(/nieuwe_groep__1/);
    });

    /**
     * The resume path. With the dropdown already there — a half-finished earlier run, or
     * simply a second invocation — provisioning goes straight to creating the row, and
     * `deriveOptionMap` waves it through: that checks labels against `GROUP_POLICY`,
     * which is code, so a leftover label passes long after the group behind it is gone
     * from Monday. The row would then be created selecting a group with no trainers.
     */
    it('refuses a deleted trainer group even when the column already exists', async () => {
      const fake = fakeBoard({ labels: LIVE });

      await expect(
        provisionGroepselectie(deps(fake, { titles: new Map([['topics', 'Topics']]) }))
      ).rejects.toThrow(/nieuwe_groep__1/);
      expect(fake.state.mutations).toEqual([]);
    });

    it('refuses an unreadable trainers board on the resume path too', async () => {
      const fake = fakeBoard({ labels: LIVE });

      await expect(provisionGroepselectie(deps(fake, { titles: new Map() }))).rejects.toThrow();
      expect(fake.state.mutations).toEqual([]);
    });

    it('refuses a column of the wrong type instead of writing to it', async () => {
      const fake = fakeBoard({ labels: LIVE, columnType: 'text' });

      await expect(provisionGroepselectie(deps(fake))).rejects.toThrow(/dropdown/);
      expect(fake.state.mutations).toEqual([]);
    });

    /**
     * An empty seed would put a row on the board that turns every training into GEEN
     * MATCH — the failure that looks most like a legitimate answer.
     */
    it('refuses to seed an empty selection', async () => {
      const fake = fakeBoard();

      await expect(provisionGroepselectie(deps(fake, { selection: [] }))).rejects.toThrow(
        /geen groep/
      );
      expect(fake.state.mutations).toEqual([]);
    });

    /**
     * The board identity check: a stray dropdown created on whatever board id was pasted
     * by mistake is a mess someone has to find and undo by hand.
     */
    it('refuses a board that is not a settings board', async () => {
      const fake = fakeBoard();
      vi.mocked(fake.read.getSchema).mockResolvedValue([
        {
          id: BOARD,
          name: 'Agenda 2026',
          groups: [],
          columns: [],
          items_count: 0,
        },
      ] as unknown as Awaited<ReturnType<MondayGraphQLClient['getSchema']>>);

      await expect(provisionGroepselectie(deps(fake))).rejects.toThrow();
      expect(fake.state.mutations).toEqual([]);
    });
  });

  /**
   * A value typed into `Waarde` is a change somebody made expecting an effect. Migrating
   * over it would leave that row looking authoritative while nothing reads it.
   */
  it('surfaces the reader’s own refusals, like a filled-in Waarde', async () => {
    const fake = fakeBoard({ labels: LIVE, row: { waarde: 'topics', selected: [1, 2] } });

    await expect(provisionGroepselectie(deps(fake))).rejects.toThrow(/Waarde/);
  });
});
