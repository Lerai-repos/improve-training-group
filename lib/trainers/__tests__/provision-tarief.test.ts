import { describe, expect, it } from 'vitest';

import { TRAINER_EXPECTED_COLUMNS, TRAINERS_BOARD } from '@lib/monday/board-config';

import {
  assertSettingsMatchTarget,
  provisionTarief,
  tariefKeyPrefix,
  UURTARIEF_COLUMN,
} from '../provision-tarief';

import type { BoardMeta, MondayGraphQLClient } from '@lib/monday/graphql-client';
import type { MondayMutationClient, MutateOptions } from '@lib/monday/mutate';

interface Item {
  id: string;
  name: string;
  group: { id: string; title: string };
  uurtarief?: string | null;
}

const EURO_BY_GROUP = new Map([
  ['topics', '88'],
  ['nieuwe_groep__1', '84'],
]);

/** The columns that make the board recognisable, plus whatever the test adds. */
function meta(extra: Array<{ id: string; type: string }> = []): BoardMeta {
  return {
    id: TRAINERS_BOARD,
    name: 'Trainers contactgegevens',
    groups: [
      { id: 'topics', title: 'Trainers instroom 2020-2024' },
      { id: 'nieuwe_groep__1', title: 'Trainers instroom 2024 - Heden' },
      { id: 'group_mm0d6p4r', title: 'Schaduwpool' },
    ],
    columns: [...TRAINER_EXPECTED_COLUMNS, ...extra].map((c) => ({
      id: c.id,
      title: c.id,
      type: c.type,
      settings_str: null,
    })),
    items_count: 0,
  };
}

interface Recorded {
  document: string;
  variables: Record<string, unknown>;
  key?: string;
}

function harness(input: { items: Item[]; columns?: Array<{ id: string; type: string }> }) {
  // Live board state, mutated by the fake writer so a read-back sees real effects.
  const items = input.items.map((i) => ({ ...i }));
  const columns = [...(input.columns ?? [])];
  const calls: Recorded[] = [];
  const projections: string[] = [];

  const read: MondayGraphQLClient = {
    query: () => Promise.reject(new Error('unexpected query')),
    preflight: () => Promise.reject(new Error('unexpected preflight')),
    getSchema: () => Promise.resolve([meta(columns)]),
    fetchBoardItems: <T extends { id: string }>(_board: string, fields: string): Promise<T[]> => {
      projections.push(fields);
      const asksForColumn = fields.includes(UURTARIEF_COLUMN);
      return Promise.resolve(
        items.map((i) => ({
          id: i.id,
          name: i.name,
          updated_at: '2026-08-18T00:00:00Z',
          group: i.group,
          column_values: asksForColumn ? [{ id: UURTARIEF_COLUMN, text: i.uurtarief ?? null }] : [],
        })) as unknown as T[]
      );
    },
    lastReportedVersion: () => '2026-07',
  };

  const write: MondayMutationClient = {
    mutate: <T>(
      document: string,
      variables: Record<string, unknown> = {},
      opts?: MutateOptions
    ): Promise<T> => {
      calls.push({ document, variables, key: opts?.idempotencyKey });
      if (document.includes('create_column')) {
        columns.push({ id: String(variables.id), type: String(variables.type) });
      }
      if (document.includes('change_multiple_column_values')) {
        const parsed: Record<string, string> = JSON.parse(String(variables.values));
        const target = items.find((i) => i.id === String(variables.item));
        if (target) {
          target.uurtarief = parsed[UURTARIEF_COLUMN];
        }
      }
      return Promise.resolve({} as T);
    },
  };

  return { read, write, calls, projections, items };
}

const deps = (h: ReturnType<typeof harness>, apply: boolean) => ({
  read: h.read,
  write: h.write,
  boardId: TRAINERS_BOARD,
  keyPrefix: tariefKeyPrefix(TRAINERS_BOARD),
  apply,
  euroByGroup: EURO_BY_GROUP,
});

const item = (id: string, group: string, uurtarief?: string | null): Item => ({
  id,
  name: `T${id}`,
  group: { id: group, title: group },
  uurtarief,
});

describe('provisionTarief', () => {
  it('creates both columns and writes the derived rates', async () => {
    const h = harness({ items: [item('1', 'topics'), item('2', 'nieuwe_groep__1')] });
    const result = await provisionTarief(deps(h, true));

    expect(result.createdColumns).toHaveLength(2);
    expect(result.written).toBe(2);
    expect(h.items.map((i) => i.uurtarief)).toEqual(['88', '84']);
  });

  it('writes nothing on a dry run', async () => {
    const h = harness({ items: [item('1', 'topics')] });
    const result = await provisionTarief(deps(h, false));

    expect(h.calls).toEqual([]);
    expect(result.written).toBe(0);
    expect(result.plan.writes).toHaveLength(1);
    // The dry run must still describe the work, or it has no value.
    expect(result.createdColumns).toHaveLength(2);
  });

  it('is idempotent: a second apply creates nothing and writes nothing', async () => {
    const h = harness({ items: [item('1', 'topics')] });
    await provisionTarief(deps(h, true));
    const second = await provisionTarief(deps(h, true));

    expect(second.createdColumns).toEqual([]);
    expect(second.written).toBe(0);
    expect(second.plan.alreadySet).toHaveLength(1);
  });

  it('refuses to overwrite a rate somebody already set', async () => {
    const h = harness({
      items: [item('1', 'topics', '125')],
      columns: [{ id: UURTARIEF_COLUMN, type: 'numbers' }],
    });
    const result = await provisionTarief(deps(h, true));

    expect(result.written).toBe(0);
    expect(h.items[0].uurtarief).toBe('125');
    expect(result.plan.alreadySet[0]).toMatchObject({ current: '125' });
  });

  it('does not ask for the column before it exists', async () => {
    // Monday omits an unknown column id instead of erroring, so querying it too early
    // would make "the column is missing" indistinguishable from "nobody filled it in".
    const h = harness({ items: [item('1', 'topics')] });
    await provisionTarief(deps(h, false));
    expect(h.projections.every((p) => !p.includes(UURTARIEF_COLUMN))).toBe(true);

    const existing = harness({
      items: [item('1', 'topics')],
      columns: [{ id: UURTARIEF_COLUMN, type: 'numbers' }],
    });
    await provisionTarief(deps(existing, false));
    expect(existing.projections.some((p) => p.includes(UURTARIEF_COLUMN))).toBe(true);
  });

  it('keys every idempotent write to the board AND the item', async () => {
    // Monday remembers a key for 30 minutes. Without the board, a run against a duplicate
    // trainers board replays production's response; without the item, trainer 2's write
    // replays trainer 1's and the second rate never lands.
    const h = harness({ items: [item('1', 'topics'), item('2', 'nieuwe_groep__1')] });
    await provisionTarief(deps(h, true));

    const keys = h.calls.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k?.includes(TRAINERS_BOARD))).toBe(true);
    expect(keys).toContain(`tarief:${TRAINERS_BOARD}:value:1`);
    expect(keys).toContain(`tarief:${TRAINERS_BOARD}:value:2`);
  });

  it('puts the per-uur warning in the column description', async () => {
    const h = harness({ items: [] });
    await provisionTarief(deps(h, true));

    const created = h.calls.find(
      (c) => c.document.includes('create_column') && c.variables.id === UURTARIEF_COLUMN
    );
    expect(String(created?.variables.description)).toContain('PER UUR');
  });

  it('refuses a board that is not the trainers board', async () => {
    const h = harness({ items: [] });
    const stripped: BoardMeta = { ...meta(), columns: [] };
    const read = { ...h.read, getSchema: () => Promise.resolve([stripped]) };

    await expect(provisionTarief({ ...deps(h, true), read })).rejects.toThrow();
    expect(h.calls).toEqual([]);
  });

  it('refuses a column that exists with the wrong type', async () => {
    const h = harness({
      items: [],
      columns: [{ id: UURTARIEF_COLUMN, type: 'text' }],
    });
    await expect(provisionTarief(deps(h, true))).rejects.toThrow(/numbers/);
  });

  it('fails when a write silently did not land', async () => {
    // change_multiple_column_values returns an id whether or not the value stuck, and
    // Monday answers a complexity refusal with HTTP 200. Only the read-back can tell.
    const h = harness({ items: [item('1', 'topics')] });
    const write: MondayMutationClient = {
      mutate: <T>(document: string, variables: Record<string, unknown> = {}): Promise<T> => {
        if (document.includes('create_column')) {
          return h.write.mutate<T>(document, variables);
        }
        return Promise.resolve({} as T); // accepted, changed nothing
      },
    };
    await expect(provisionTarief({ ...deps(h, true), write })).rejects.toThrow(/nog leeg/);
  });

  /**
   * The one input that could make this command destructive.
   *
   * Monday omits an unrecognised column instead of erroring, so a renamed column or a
   * partial payload looks exactly like an empty cell — and an empty cell gets written.
   * Somebody's personal rate would be replaced by the cohort rate, silently.
   */
  it('refuses an item that omits the cell while the column exists', async () => {
    const h = harness({
      items: [item('1', 'topics', '125')],
      columns: [{ id: UURTARIEF_COLUMN, type: 'numbers' }],
    });
    const read: MondayGraphQLClient = {
      ...h.read,
      fetchBoardItems: <T extends { id: string }>(): Promise<T[]> =>
        Promise.resolve([
          {
            id: '1',
            name: 'T1',
            updated_at: '2026-08-18T00:00:00Z',
            group: { id: 'topics', title: 'topics' },
            column_values: [], // the column exists, Monday returned nothing for it
          },
        ] as unknown as T[]),
    };

    await expect(provisionTarief({ ...deps(h, true), read })).rejects.toThrow(/ontbrekende/);
    expect(h.items[0].uurtarief).toBe('125');
  });

  it('accepts a present cell holding an empty value', async () => {
    // Present-but-empty is the normal unset state and must stay writable.
    const h = harness({
      items: [item('1', 'topics', null)],
      columns: [{ id: UURTARIEF_COLUMN, type: 'numbers' }],
    });
    const result = await provisionTarief(deps(h, true));
    expect(result.written).toBe(1);
    expect(h.items[0].uurtarief).toBe('88');
  });

  it('leaves trainers outside a cohort group untouched', async () => {
    const h = harness({
      items: [item('1', 'topics'), item('2', 'group_mm0d6p4r')],
    });
    const result = await provisionTarief(deps(h, true));

    expect(result.written).toBe(1);
    expect(h.items[1].uurtarief).toBeUndefined();
    expect(result.plan.noCohort).toEqual([{ groupTitle: 'group_mm0d6p4r', count: 1 }]);
  });
});

describe('assertSettingsMatchTarget', () => {
  const PROD_SETTINGS = '5102171946';

  it('allows the production pairing', () => {
    expect(() =>
      assertSettingsMatchTarget({
        settingsBoardId: PROD_SETTINGS,
        productionSettingsBoardId: PROD_SETTINGS,
        targetBoardId: TRAINERS_BOARD,
      })
    ).not.toThrow();
  });

  /**
   * The failure this exists for: preview tariffs written onto 50 real trainers.
   *
   * Nothing downstream could catch it — a preview board yields perfectly well-formed
   * euro amounts, they just are not ITG's.
   */
  it('refuses preview settings aimed at the production trainers board', () => {
    expect(() =>
      assertSettingsMatchTarget({
        settingsBoardId: '9999999999',
        productionSettingsBoardId: PROD_SETTINGS,
        targetBoardId: TRAINERS_BOARD,
      })
    ).toThrow(/MONDAY_INSTELLINGEN_BOARD_ID/);
  });

  it('leaves a non-production target alone, where a preview pairing is coherent', () => {
    expect(() =>
      assertSettingsMatchTarget({
        settingsBoardId: '9999999999',
        productionSettingsBoardId: PROD_SETTINGS,
        targetBoardId: '1234567890',
      })
    ).not.toThrow();
  });
});
