import { beforeEach, describe, expect, it, vi } from 'vitest';

import { whatsappColumnsFor } from '@lib/monday/board-config';

import { createNullCityStore } from '../city-store';
import { createMemoryKvStore } from '../kv';
import {
  BOARD_MEMO_TTL_MS,
  authorizeItemBoard,
  handleWhatsappDiscard,
  handleWhatsappGet,
  handleWhatsappSave,
  parseWhatsappRead,
  type TrainingRead,
  type WhatsappDeps,
} from '../whatsapp-service';
import { ABSENT_TOKEN, createWhatsappStore } from '../whatsapp-store';

import type { CityStore } from '../city-store';
import type { KvStore } from '../kv';

const BOARD = '5087396949';
const ITEM = '3141071021';
const COLUMNS = whatsappColumnsFor(BOARD);
const id = (field: string): string => {
  const found = COLUMNS.find((column) => column.field === field);
  if (found === undefined) {
    throw new Error(field);
  }
  return found.id;
};

function trainingRead(over: Partial<TrainingRead> = {}): TrainingRead {
  return {
    itemName: 'Rabobank',
    boardId: BOARD,
    values: new Map([
      [id('datum'), '2026-03-23'],
      [id('thema'), 'Effectief time management'],
      [id('tijden'), '09.00-13.00'],
      [id('taal'), 'ENG'],
      [id('locatie'), 'Naritaweg 51, 1043 BP Amsterdam'],
      [id('deelnemers'), '9'],
      [id('trainers'), '2'],
      [id('acteurs'), '1'],
      [id('klant'), 'Rabobank'],
    ]),
    present: new Set(COLUMNS.map((column) => column.id)),
    boardColumns: new Map(
      COLUMNS.map((column) => [
        column.id,
        { type: column.type, settingsStr: (column.settingsIncludes ?? []).join(' ') },
      ])
    ),
    ...over,
  };
}

function deps(over: Partial<WhatsappDeps> = {}): WhatsappDeps {
  const kv: KvStore = createMemoryKvStore();
  return {
    reader: { read: () => Promise.resolve(trainingRead()) },
    store: createWhatsappStore(kv, () => new Date('2026-08-11T09:00:00.000Z')),
    cities: createNullCityStore(),
    boards: { readBoardId: () => Promise.resolve(BOARD) },
    kv,
    boardId: BOARD,
    ...over,
  };
}

const ok = (result: { status: number; body: unknown }): Record<string, unknown> => {
  const body = result.body as { success: boolean; data?: unknown };
  if (!body.success) {
    throw new Error(`expected success, got ${JSON.stringify(result)}`);
  }
  return body.data as Record<string, unknown>;
};

describe('handleWhatsappGet', () => {
  it('reports no corruption for a healthy record', async () => {
    expect(ok(await handleWhatsappGet(deps(), ITEM)).unreadable).toBe(false);
  });

  it('generates the message from the live columns', async () => {
    const data = ok(await handleWhatsappGet(deps(), ITEM));

    expect(data.generated).toBe(
      [
        'Ben jij beschikbaar?',
        '',
        '23-03-2026',
        'Effectief time management',
        '09.00-13.00 uur',
        'Engels',
        'Naritaweg 51, 1043 BP Amsterdam',
        '9 deelnemers',
        '2 trainers',
        '+1 acteur',
        'Rabobank',
      ].join('\n')
    );
    expect(data.saved).toBeNull();
    expect(data.token).toBe(ABSENT_TOKEN);
  });

  describe('the city', () => {
    const cities = (map: Record<string, string>): CityStore => ({
      lookup: (location) => Promise.resolve(map[location] ?? null),
      remember: () => Promise.resolve(),
    });

    it('prints the town when the address step resolved one', async () => {
      const data = ok(
        await handleWhatsappGet(
          deps({ cities: cities({ 'Naritaweg 51, 1043 BP Amsterdam': 'Amsterdam' }) }),
          ITEM
        )
      );

      expect(String(data.generated)).toContain('\nAmsterdam\n');
    });

    /**
     * The defect that killed freezing the city onto the artifact: edit Locatie without
     * recalculating and a frozen city would still say the old town, leaving the
     * generated text unchanged and the staleness guard silent.
     */
    it('falls back to the raw text when the location changed since it was classified', async () => {
      const read = trainingRead();
      read.values.set(id('locatie'), 'Jaarbeursplein 6A, 3521 AL Utrecht');

      const data = ok(
        await handleWhatsappGet(
          deps({
            reader: { read: () => Promise.resolve(read) },
            // Only the OLD address is cached.
            cities: cities({ 'Naritaweg 51, 1043 BP Amsterdam': 'Amsterdam' }),
          }),
          ITEM
        )
      );

      expect(String(data.generated)).toContain('Jaarbeursplein 6A, 3521 AL Utrecht');
      expect(String(data.generated)).not.toContain('Amsterdam');
    });

    it('asks for no city at all when the Locatie column drifted', async () => {
      const lookup = vi.fn(() => Promise.resolve('Amsterdam'));
      const read = trainingRead();
      read.boardColumns.set(id('locatie'), { type: 'numbers', settingsStr: null });

      await handleWhatsappGet(
        deps({
          reader: { read: () => Promise.resolve(read) },
          cities: { lookup, remember: () => Promise.resolve() },
        }),
        ITEM
      );

      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('drift', () => {
    it('drops the line and names the column, rather than printing an untrusted value', async () => {
      const read = trainingRead();
      read.values.set(id('klant'), 'De verkeerde klant BV');
      read.boardColumns.set(id('klant'), { type: 'mirror', settingsStr: '{"boardIds":[999]}' });
      read.itemName = null;

      const data = ok(await handleWhatsappGet(deps({ reader: { read: () => Promise.resolve(read) } }), ITEM));

      expect(String(data.generated)).not.toContain('De verkeerde klant BV');
      expect((data.warnings as string[]).join(' ')).toMatch(/klant/);
    });

    /**
     * Some drifted columns have an untainted fallback, so the line is still there. A
     * warning saying it was left out would contradict the message beside it.
     */
    it('says the source was ignored when a fallback rendered the line anyway', async () => {
      const read = trainingRead();
      // The Bedrijf mirror drifted, but the item name still supplies a klant line.
      read.boardColumns.set(id('klant'), { type: 'mirror', settingsStr: '{"boardIds":[999]}' });

      const data = ok(await handleWhatsappGet(deps({ reader: { read: () => Promise.resolve(read) } }), ITEM));

      expect(String(data.generated)).toContain('Rabobank');
      const warning = (data.warnings as string[]).find((w) => w.includes('klant'));
      expect(warning).toMatch(/genegeerd/);
      expect(warning).not.toMatch(/weggelaten/);
    });

    it('says the line was left out when nothing could replace it', async () => {
      const read = trainingRead();
      read.boardColumns.set(id('klant'), { type: 'mirror', settingsStr: '{"boardIds":[999]}' });
      read.itemName = null;

      const data = ok(await handleWhatsappGet(deps({ reader: { read: () => Promise.resolve(read) } }), ITEM));

      expect((data.warnings as string[]).find((w) => w.includes('klant'))).toMatch(/weggelaten/);
    });

    /**
     * The conditional lines are absent from `omitted` by design, so inferring "rendered"
     * from it claimed a drifted trainer column had a fallback. It has none.
     */
    it('does not claim a fallback for a drifted trainer column', async () => {
      const read = trainingRead();
      read.boardColumns.set(id('trainers'), { type: 'text', settingsStr: null });

      const data = ok(await handleWhatsappGet(deps({ reader: { read: () => Promise.resolve(read) } }), ITEM));

      expect(String(data.generated)).not.toContain('trainers');
      const warning = (data.warnings as string[]).find((w) => w.includes('trainers'));
      expect(warning).toMatch(/weggelaten/);
      expect(warning).not.toMatch(/genegeerd/);
    });

    it('does not fail the request', async () => {
      const read = trainingRead();
      read.present.delete(id('tijden'));

      const result = await handleWhatsappGet(deps({ reader: { read: () => Promise.resolve(read) } }), ITEM);

      expect(result.status).toBe(200);
    });
  });

  it('names the fields the planner has not filled in', async () => {
    const read = trainingRead();
    read.values.delete(id('deelnemers'));

    const data = ok(await handleWhatsappGet(deps({ reader: { read: () => Promise.resolve(read) } }), ITEM));

    expect((data.warnings as string[]).join(' ')).toMatch(/deelnemers/);
  });

  it('refuses an item on another board', async () => {
    const read = trainingRead({ boardId: '999' });

    const result = await handleWhatsappGet(deps({ reader: { read: () => Promise.resolve(read) } }), ITEM);

    expect(result.status).toBe(403);
  });

  it('reports a training that is not there', async () => {
    const result = await handleWhatsappGet(deps({ reader: { read: () => Promise.resolve(null) } }), ITEM);
    expect(result.status).toBe(404);
  });

  it('tells the planner when a saved edit could not be read', async () => {
    const d = deps();
    await d.kv.set(`whatsapp:${ITEM}`, 'not json');

    const data = ok(await handleWhatsappGet(d, ITEM));

    expect(data.saved).toBeNull();
    // A structured flag, not a sentence: the panel must be able to clear THIS notice on
    // recovery without discarding the drift and truncation warnings beside it.
    expect(data.unreadable).toBe(true);
    expect(data.token).not.toBe(ABSENT_TOKEN);
  });

  it('remembers the board, so the autosaves that follow cost no Monday call', async () => {
    const readBoardId = vi.fn(() => Promise.resolve(BOARD));
    const d = deps({ boards: { readBoardId } });

    await handleWhatsappGet(d, ITEM);
    await handleWhatsappSave(d, ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });

    expect(readBoardId).not.toHaveBeenCalled();
  });
});

describe('authorizeItemBoard', () => {
  let kv: KvStore;
  beforeEach(() => {
    kv = createMemoryKvStore();
  });

  it('looks the board up when nothing is memoised', async () => {
    const readBoardId = vi.fn(() => Promise.resolve(BOARD));

    expect(await authorizeItemBoard({ boards: { readBoardId }, kv, boardId: BOARD }, ITEM)).toBe(true);
    expect(readBoardId).toHaveBeenCalledOnce();
  });

  it('refuses an item on another board', async () => {
    const readBoardId = () => Promise.resolve('999');
    expect(await authorizeItemBoard({ boards: { readBoardId }, kv, boardId: BOARD }, ITEM)).toBe(false);
  });

  /** A nonexistent id resolves to no board, and nothing is writable without one. */
  it('refuses an item that does not exist', async () => {
    const readBoardId = () => Promise.resolve(null);
    expect(await authorizeItemBoard({ boards: { readBoardId }, kv, boardId: BOARD }, ITEM)).toBe(false);
  });

  it('does not memoise a refusal it could not verify', async () => {
    const readBoardId = vi.fn(() => Promise.resolve(null));
    const config = { boards: { readBoardId }, kv, boardId: BOARD };

    await authorizeItemBoard(config, ITEM);
    await authorizeItemBoard(config, ITEM);

    expect(readBoardId).toHaveBeenCalledTimes(2);
  });

  it('uses the memo on the second call', async () => {
    const readBoardId = vi.fn(() => Promise.resolve(BOARD));
    const config = { boards: { readBoardId }, kv, boardId: BOARD };

    await authorizeItemBoard(config, ITEM);
    await authorizeItemBoard(config, ITEM);

    expect(readBoardId).toHaveBeenCalledOnce();
  });

  /** It is an authorization input, so it must not be trusted forever. */
  it('re-checks once the memo expires', async () => {
    let clock = 0;
    const timed = createMemoryKvStore(() => clock);
    const readBoardId = vi.fn(() => Promise.resolve(BOARD));
    const config = { boards: { readBoardId }, kv: timed, boardId: BOARD };

    await authorizeItemBoard(config, ITEM);
    clock = BOARD_MEMO_TTL_MS + 1;
    await authorizeItemBoard(config, ITEM);

    expect(readBoardId).toHaveBeenCalledTimes(2);
  });

  it('refuses when the memo says another board', async () => {
    await kv.set(`board-of:${ITEM}`, '999');
    const readBoardId = vi.fn(() => Promise.resolve(BOARD));

    expect(await authorizeItemBoard({ boards: { readBoardId }, kv, boardId: BOARD }, ITEM)).toBe(false);
    expect(readBoardId).not.toHaveBeenCalled();
  });
});

describe('handleWhatsappSave', () => {
  it('stores the edit and returns the new token', async () => {
    const d = deps();

    const data = ok(await handleWhatsappSave(d, ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN }));

    expect(data.saved).toEqual({ edited: 'D', base: 'S' });
    expect(data.token).not.toBe(ABSENT_TOKEN);
  });

  it('refuses an item on another board', async () => {
    const d = deps({ boards: { readBoardId: () => Promise.resolve('999') } });

    const result = await handleWhatsappSave(d, ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });

    expect(result.status).toBe(403);
  });

  it('refuses a nonexistent item', async () => {
    const d = deps({ boards: { readBoardId: () => Promise.resolve(null) } });

    const result = await handleWhatsappSave(d, ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });

    expect(result.status).toBe(403);
  });

  it('rejects an oversized edit', async () => {
    const result = await handleWhatsappSave(deps(), ITEM, {
      edited: 'x'.repeat(9000),
      base: 'S',
      token: ABSENT_TOKEN,
    });

    expect(result.status).toBe(422);
  });

  it('rejects a body without a token', async () => {
    expect((await handleWhatsappSave(deps(), ITEM, { edited: 'D', base: 'S' })).status).toBe(422);
  });

  /** Clearing the box is a revert, not a stored empty string. */
  it('treats an emptied edit as a discard', async () => {
    const d = deps();
    const saved = ok(await handleWhatsappSave(d, ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN }));

    const result = await handleWhatsappSave(d, ITEM, {
      edited: '   ',
      base: 'S',
      token: String(saved.token),
    });

    expect(result.status).toBe(200);
    expect((await d.store.read(ITEM)).saved).toBeNull();
  });

  describe('conflict', () => {
    it('reports 409 with what is really stored, so no draft has to be thrown away', async () => {
      const d = deps();
      await handleWhatsappSave(d, ITEM, { edited: 'mine', base: 'S', token: ABSENT_TOKEN });

      const result = await handleWhatsappSave(d, ITEM, {
        edited: 'theirs',
        base: 'S',
        token: ABSENT_TOKEN,
      });

      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({
        data: { saved: { edited: 'mine', base: 'S' } },
      });
    });

    /** Redis committed, the reply was lost, the client retried. Not a colleague. */
    it('reports success for a retried identical save', async () => {
      const d = deps();
      const first = ok(await handleWhatsappSave(d, ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN }));

      const retry = await handleWhatsappSave(d, ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN });

      expect(retry.status).toBe(200);
      expect(ok(retry).token).toBe(first.token);
    });
  });
});

describe('handleWhatsappDiscard', () => {
  it('reverts to the generated message', async () => {
    const d = deps();
    const saved = ok(await handleWhatsappSave(d, ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN }));

    const result = await handleWhatsappDiscard(d, ITEM, { token: String(saved.token) });

    expect(result.status).toBe(200);
    expect((await d.store.read(ITEM)).saved).toBeNull();
  });

  it('is idempotent when its response was lost', async () => {
    const d = deps();
    const saved = ok(await handleWhatsappSave(d, ITEM, { edited: 'D', base: 'S', token: ABSENT_TOKEN }));
    await handleWhatsappDiscard(d, ITEM, { token: String(saved.token) });

    expect((await handleWhatsappDiscard(d, ITEM, { token: String(saved.token) })).status).toBe(200);
  });

  it('refuses an item on another board', async () => {
    const d = deps({ boards: { readBoardId: () => Promise.resolve('999') } });

    expect((await handleWhatsappDiscard(d, ITEM, { token: ABSENT_TOKEN })).status).toBe(403);
  });
});

describe('parseWhatsappRead', () => {
  const raw = {
    items: [
      {
        id: ITEM,
        name: 'Rabobank',
        board: { id: BOARD, columns: [{ id: 'tekst', type: 'text', settings_str: '{}' }] },
        column_values: [
          { id: 'tekst', type: 'text', text: 'Time management' },
          { id: 'lookup_mkszzfvr', type: 'mirror', text: null, display_value: 'The July' },
          { id: 'dup__of_workshop', type: 'text', text: '' },
        ],
      },
    ],
  };

  it('reads names, board and values', () => {
    const read = parseWhatsappRead(raw, ITEM);

    expect(read?.itemName).toBe('Rabobank');
    expect(read?.boardId).toBe(BOARD);
    expect(read?.values.get('tekst')).toBe('Time management');
  });

  /** Mirrors and relations carry `text: null` — verified across 756 live items. */
  it('takes a mirror value from display_value', () => {
    expect(parseWhatsappRead(raw, ITEM)?.values.get('lookup_mkszzfvr')).toBe('The July');
  });

  /** Returned-but-empty is present; omitted is missing. The drift check depends on it. */
  it('separates an empty value from an absent column', () => {
    const read = parseWhatsappRead(raw, ITEM);

    expect(read?.present.has('dup__of_workshop')).toBe(true);
    expect(read?.values.has('dup__of_workshop')).toBe(false);
  });

  it('is null for an item that is not there', () => {
    expect(parseWhatsappRead({ items: [] }, ITEM)).toBeNull();
    expect(parseWhatsappRead({ nonsense: true }, ITEM)).toBeNull();
  });
});
