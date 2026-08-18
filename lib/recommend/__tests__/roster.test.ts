import { describe, expect, it } from 'vitest';

import {
  TRAINER_COLUMNS,
  TRAINER_ENGINE_COLUMNS,
  TRAINERS_BOARD,
} from '@lib/monday/board-config';

import { NOTK_PLACEHOLDER_ITEM_ID, readRoster, toRoster } from '../roster';

import type { BoardMeta } from '@lib/monday/graphql-client';
import type { MondayTrainer } from '@lib/monday';

/**
 * A board whose configured columns are all present and correctly typed. Derived
 * from TRAINER_ENGINE_COLUMNS so the fixture cannot drift from the contract it is
 * meant to satisfy.
 */
const healthyBoard: BoardMeta = {
  id: TRAINERS_BOARD,
  name: 'Trainers',
  groups: [{ id: 'topics', title: 'Trainers instroom 2020-2024' }],
  items_count: 1,
  columns: TRAINER_ENGINE_COLUMNS.map((c) => ({
    id: c.id,
    title: c.id,
    type: c.type,
    settings_str: null,
  })),
};

function fakeClient(board: BoardMeta): Parameters<typeof readRoster>[0] {
  return {
    getSchema: () => Promise.resolve([board]),
    fetchBoardItems: <T extends { id: string }>(): Promise<T[]> => Promise.resolve([]),
  };
}

const raw = (over: Partial<MondayTrainer> & { externalItemId: string }): MondayTrainer => ({
  externalBoardId: '1661151090',
  uurtariefRaw: null,
  naam: `T${over.externalItemId}`,
  adres: 'Straat 1',
  email: null,
  telefoon: null,
  mondayGroup: 'topics',
  rateKey: null, // the decoder always leaves this null — see toRoster
  ...over,
});

describe('toRoster', () => {
  /**
   * The decoder sets `rateKey: null` and the ONLY place it was ever filled was
   * `scripts/sync-monday.ts`, which this migration deletes. Without this mapping
   * every trainer is unpriceable, every run returns GEEN MATCH, and nothing errors
   * — `no_rate` is a designed exclusion.
   */
  it('fills rateKey from the group policy', () => {
    const roster = toRoster([
      raw({ externalItemId: '1', mondayGroup: 'topics' }),
      raw({ externalItemId: '2', mondayGroup: 'nieuwe_groep__1' }),
    ]);
    expect(roster.map((t) => t.rateKey)).toEqual(['2020-2024', '2024-heden']);
  });

  it('leaves rateKey null for a group with no policy (imported, unpriceable)', () => {
    const roster = toRoster([raw({ externalItemId: '1', mondayGroup: 'group_mm0d6p4r' })]);
    expect(roster[0].rateKey).toBeNull();
  });

  it('leaves rateKey null when the trainer has no group at all', () => {
    const roster = toRoster([raw({ externalItemId: '1', mondayGroup: null })]);
    expect(roster[0].rateKey).toBeNull();
  });

  /**
   * `*NOTK` is a placeholder, not a person, and it IS linked from real training
   * records — so it reaches the engine and could be ranked and recommended.
   */
  it('excludes the *NOTK placeholder by item id', () => {
    const roster = toRoster([
      raw({ externalItemId: NOTK_PLACEHOLDER_ITEM_ID, naam: '*NOTK' }),
      raw({ externalItemId: '1661151129' }),
    ]);
    expect(roster.map((t) => t.externalItemId)).toEqual(['1661151129']);
  });

  it('excludes *NOTK even if it has been renamed', () => {
    const roster = toRoster([
      raw({ externalItemId: NOTK_PLACEHOLDER_ITEM_ID, naam: 'Nog Te Bepalen' }),
    ]);
    expect(roster).toHaveLength(0);
  });

  /**
   * Group filtering belongs to the recommendation service, NOT here: groups:list
   * and the readiness API have to report on groups that are not selected, which is
   * impossible if the roster is pre-filtered.
   */
  it('returns trainers from EVERY group, unfiltered', () => {
    const roster = toRoster([
      raw({ externalItemId: '1', mondayGroup: 'topics' }),
      raw({ externalItemId: '2', mondayGroup: 'group_mm0d6p4r' }), // Schaduwpool
      raw({ externalItemId: '3', mondayGroup: 'group_mkxyf1vc' }), // Inactief
    ]);
    expect(roster).toHaveLength(3);
    expect(roster.map((t) => t.mondayGroup)).toEqual([
      'topics',
      'group_mm0d6p4r',
      'group_mkxyf1vc',
    ]);
  });

  it('carries the identity, name, address and group through', () => {
    const [t] = toRoster([
      raw({ externalItemId: '1661151129', naam: 'Sylvie', adres: 'Teststraat 1' }),
    ]);
    expect(t).toEqual({
      externalItemId: '1661151129',
      naam: 'Sylvie',
      adres: 'Teststraat 1',
      mondayGroup: 'topics',
      rateKey: '2020-2024',
      rateOverride: { kind: 'none' },
    });
  });

  it('decodes the Uurtarief cell into a per-trainer override', () => {
    const [t] = toRoster([raw({ externalItemId: '1', uurtariefRaw: '125' })]);
    expect(t.rateOverride).toEqual({ kind: 'cents', cents: 12500 });
  });

  /**
   * One unreadable cell must not throw here.
   *
   * `toRoster` runs once for the whole board, so a single typo would take down every
   * recommendation for every training. It is carried as `invalid` and costs exactly the
   * one trainer, which `trainerHourlyRateCents` then refuses to price.
   */
  it('carries an unreadable Uurtarief without failing the whole board', () => {
    const roster = toRoster([
      raw({ externalItemId: '1', uurtariefRaw: '500' }),
      raw({ externalItemId: '2', uurtariefRaw: '88' }),
    ]);
    expect(roster[0].rateOverride.kind).toBe('invalid');
    expect(roster[1].rateOverride).toEqual({ kind: 'cents', cents: 8800 });
  });
});

/**
 * The sync-time validator that used to police board schema is deleted with the
 * database, and the decoders FAIL OPEN: a missing or retyped address column becomes
 * `null` for every trainer, so they are all excluded as `no_address` and the run
 * returns a perfectly plausible GEEN MATCH with no error anywhere.
 */
describe('readRoster schema drift', () => {
  it('reads a healthy board', async () => {
    await expect(readRoster(fakeClient(healthyBoard), 'id updated_at')).resolves.toEqual([]);
  });

  it('throws when a configured column is MISSING', async () => {
    const board = {
      ...healthyBoard,
      columns: healthyBoard.columns.filter((c) => c.id !== TRAINER_COLUMNS.adres),
    };
    await expect(readRoster(fakeClient(board), 'id updated_at')).rejects.toThrow(
      /missing column|adres/i
    );
  });

  it('throws when a configured column is RETYPED', async () => {
    const board = {
      ...healthyBoard,
      columns: healthyBoard.columns.map((c) =>
        c.id === TRAINER_COLUMNS.adres ? { ...c, type: 'long_text' } : c
      ),
    };
    await expect(readRoster(fakeClient(board), 'id updated_at')).rejects.toThrow(/long_text/);
  });
});

/**
 * Regression: an earlier version let callers pass a bare item count, and both
 * adapters then took a `??` shortcut PAST the schema check. Supplying pre-fetched
 * metadata must still validate it — otherwise the optimization silently disables
 * the guard it was meant to make cheap.
 */
describe('readRoster with prefetched metadata', () => {
  it('still validates a board handed to it', async () => {
    const drifted: BoardMeta = {
      ...healthyBoard,
      columns: healthyBoard.columns.filter((c) => c.id !== TRAINER_COLUMNS.adres),
    };
    // The client would return a HEALTHY board; the prefetched one is drifted.
    await expect(readRoster(fakeClient(healthyBoard), 'id updated_at', drifted)).rejects.toThrow(
      /schema drift|missing column/i
    );
  });

  it('rejects metadata for the wrong board', async () => {
    const other: BoardMeta = { ...healthyBoard, id: '9999999999' };
    await expect(readRoster(fakeClient(healthyBoard), 'id updated_at', other)).rejects.toThrow(
      /mismatch/i
    );
  });
});

/**
 * The board-level preflight cannot see a payload that is incomplete for ONE item,
 * or a column change that races it. `decodeTrainer` fails open — an absent `adres`
 * column is indistinguishable from an empty one — so that trainer would be silently
 * excluded as `no_address`.
 */
describe('readRoster per-item payload validation', () => {
  const item = (columns: string[]) => ({
    id: '1661151129',
    name: 'T',
    updated_at: '2026-01-01T00:00:00Z',
    board: { id: TRAINERS_BOARD },
    group: { id: 'topics', title: 'T' },
    column_values: columns.map((id) => ({ id, type: 'text', text: 'x' })),
  });
  const allColumns = Object.values(TRAINER_COLUMNS).filter((c): c is string => c !== undefined);

  function clientWithItems(items: ReturnType<typeof item>[]): Parameters<typeof readRoster>[0] {
    return {
      getSchema: () => Promise.resolve([healthyBoard]),
      fetchBoardItems: <T extends { id: string }>(): Promise<T[]> =>
        Promise.resolve(items as unknown as T[]),
    };
  }

  it('accepts an item carrying every consumed column', async () => {
    const roster = await readRoster(clientWithItems([item(allColumns)]), 'x');
    expect(roster).toHaveLength(1);
  });

  it('throws when an item omits the address column entirely', async () => {
    const without = allColumns.filter((c) => c !== TRAINER_COLUMNS.adres);
    await expect(readRoster(clientWithItems([item(without)]), 'x')).rejects.toThrow(/adres/);
  });
});
