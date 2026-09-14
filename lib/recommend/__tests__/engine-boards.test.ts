import { describe, expect, it, vi } from 'vitest';

import { AGENDA_2026_HISTORY } from '@lib/evaluations';

import {
  createEngineBoards,
  engineBoardProblem,
  notServedResult,
  requireReadable,
  trainingColumnsFor,
  type EngineBoardRules,
} from '../engine-boards';
import { createMemoryKvStore } from '../kv';

import type { AgendaBoard, AgendaBoardSet, AgendaClassification } from '@lib/evaluations';

/**
 * Welke agendaborden aanbevelingen krijgen. Gemeten 14-Sep-2026: Agenda 2026 heeft de
 * statuskolom en beide triggergroepen, Agenda 2025 mist de statuskolom. Een kopie van 2026
 * neemt alles mee en hoort dus vanzelf mee te doen.
 */

const RULES: EngineBoardRules = {
  statusColumnId: 'color_ours',
  triggerGroupIds: ['group_inplannen', 'nieuwe_groep'],
};

const bord = (boardId: string, over: Partial<AgendaBoard> = {}): AgendaBoard => ({
  ...AGENDA_2026_HISTORY,
  boardId,
  naam: `Agenda ${boardId}`,
  gearchiveerd: false,
  groupIds: ['group_inplannen', 'nieuwe_groep'],
  columnTypes: { color_ours: 'status' },
  ...over,
});

function harness(input: {
  set: AgendaBoardSet;
  live?: AgendaClassification;
  itemBoard?: string | null;
  override?: string | null;
  kv?: ReturnType<typeof createMemoryKvStore>;
}) {
  const kv = input.kv ?? createMemoryKvStore();
  const discover = vi.fn(async () => input.set);
  const readBoard = vi.fn(
    async (): Promise<AgendaClassification> => input.live ?? { kind: 'geen-agenda' }
  );
  const boards = createEngineBoards({
    kv,
    client: { query: async () => ({}) },
    items: { readBoardId: async () => (input.itemBoard === undefined ? '2027' : input.itemBoard) },
    rules: RULES,
    override: input.override ?? null,
    discover,
    readBoard,
  });
  return { boards, discover, readBoard, kv };
}

describe('engineBoardProblem', () => {
  it('keurt een kopie van 2026 goed', () => {
    expect(engineBoardProblem(bord('2027'), RULES)).toBeNull();
  });

  it.each([
    ['een gearchiveerd bord', bord('x', { gearchiveerd: true }), /gearchiveerd/],
    ['een bord zonder statuskolom, zoals 2025', bord('x', { columnTypes: {} }), /statuskolom/],
    [
      'een statuskolom van een ander type',
      bord('x', { columnTypes: { color_ours: 'text' } }),
      /geen statuskolom/,
    ],
    ['een ontbrekende triggergroep', bord('x', { groupIds: ['group_inplannen'] }), /nieuwe_groep/],
  ])('weigert %s', (_naam, board, reden) => {
    expect(engineBoardProblem(board, RULES)).toMatch(reden);
  });
});

describe('trainingColumnsFor', () => {
  /** Een id van het verkeerde jaar geeft bij Monday geen fout maar een lege relatie. */
  it('neemt de relaties van het bord zelf', () => {
    const columns = trainingColumnsFor({
      ...AGENDA_2026_HISTORY,
      trainerRelation: 'lead_x',
      coTrainerRelation: undefined,
      themaRelation: 'thema_x',
    });
    expect(columns.themaRelation).toBe('thema_x');
    expect(columns.trainerRelation).toBe('lead_x');
    expect(columns.coTrainerRelation).toBeUndefined();
    expect(columns.datum).toBe('datum_1');
  });
});

describe('createEngineBoards', () => {
  const SET: AgendaBoardSet = {
    boards: [bord('2026'), bord('2025', { columnTypes: {} }), bord('2024', { gearchiveerd: true })],
    rejected: [{ boardId: 'kapot', naam: 'Kopie', reden: 'de kolommen kloppen niet' }],
  };

  it('bedient een agendabord met statuskolom en triggergroepen', async () => {
    const { boards } = harness({ set: SET });
    expect((await boards.check('2026')).kind).toBe('served');
  });

  it('bedient een agendabord zonder statuskolom niet, en zegt waarom', async () => {
    const { boards } = harness({ set: SET });
    const uit = await boards.check('2025');
    expect(uit.kind === 'not-served' && uit.reden).toMatch(/statuskolom/);
  });

  it('noemt de reden van een bord dat op een agenda lijkt maar niet bruikbaar is', async () => {
    const { boards } = harness({ set: SET });
    const uit = await boards.check('kapot');
    expect(uit.kind === 'not-served' && uit.reden).toBe('de kolommen kloppen niet');
  });

  /** Een bord dat na het vullen van de cache is gedupliceerd hoeft geen kwartier te wachten. */
  it('keurt een onbekend bord live, zodat een verse kopie meteen meedoet', async () => {
    const { boards, readBoard } = harness({
      set: SET,
      live: { kind: 'agenda', board: bord('2027') },
    });
    expect((await boards.check('2027')).kind).toBe('served');
    expect(readBoard).toHaveBeenCalledOnce();
  });

  it('bedient een onbekend bord dat geen agenda is niet', async () => {
    const { boards } = harness({ set: SET });
    expect((await boards.check('42')).kind).toBe('not-served');
  });

  it('bedient bij de testoverride alleen dat ene bord', async () => {
    const { boards } = harness({ set: SET, override: '2027' });
    expect((await boards.check('2026')).kind).toBe('not-served');
  });

  it('zoekt niet opnieuw zolang de lijst in KV staat', async () => {
    const kv = createMemoryKvStore();
    await harness({ set: SET, kv }).boards.check('2026');
    const tweede = harness({ set: SET, kv });
    await tweede.boards.check('2026');
    expect(tweede.discover).not.toHaveBeenCalled();
  });

  /** Een item dat even niet te lezen is mag niet als "valt erbuiten" worden losgelaten. */
  it('noemt een onleesbaar item onleesbaar, niet onbediend', async () => {
    const { boards } = harness({ set: SET, itemBoard: null });
    const uit = await boards.forItem('1');
    expect(uit.kind).toBe('unreadable');
    expect(() => requireReadable(uit)).toThrow(/gedeeld/);
  });

  it('noemt een bord dat Monday niet teruggeeft onleesbaar', async () => {
    const { boards } = harness({ set: SET, live: { kind: 'niet-gevonden' } });
    expect((await boards.check('42')).kind).toBe('unreadable');
  });

  it('laat een vastgestelde uitkomst door requireReadable heen', async () => {
    const { boards } = harness({ set: SET });
    expect(requireReadable(await boards.check('2025')).kind).toBe('not-served');
  });

  it('kijkt voor een item naar het bord waar het op staat', async () => {
    const { boards } = harness({ set: SET, itemBoard: '2026' });
    expect((await boards.forItem('1')).kind).toBe('served');
  });

  it('splitst de actieve borden in bediend en geweigerd, zonder gearchiveerde', async () => {
    const { boards } = harness({ set: SET });
    const { served, refused } = await boards.list();
    expect(served.map((b) => b.boardId)).toEqual(['2026']);
    expect(refused.map((r) => r.board.boardId)).toEqual(['2025']);
  });
});

describe('notServedResult', () => {
  /** Opnieuw proberen verandert het bord niet; de wachtrij moet stoppen. */
  it('is een FOUT die niet opnieuw geprobeerd wordt', () => {
    const uit = notServedResult('het bord is gearchiveerd');
    expect(uit.ok).toBe(false);
    expect(!uit.ok && uit.failure.retryable).toBe(false);
  });
});
