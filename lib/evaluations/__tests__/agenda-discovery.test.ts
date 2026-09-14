import { describe, expect, it } from 'vitest';

import { THEMAS_BOARD, TRAINERS_BOARD } from '@lib/monday/board-config';

import {
  classifyAgendaBoard,
  classifyAgendaBoards,
  discoverAgendaBoards,
  readAgendaBoard,
  resolveAgendaBoards,
  type BoardsQueryClient,
  type DiscoveredBoard,
  type DiscoveredColumn,
} from '../agenda-discovery';

/**
 * Een agendabord herkennen aan zijn kolommen.
 *
 * De vorm van deze borden is op 14-Sep-2026 live gemeten: 2026 heeft een lead- en een
 * co-trainerrelatie, 2025 één trainerrelatie met een ander id. Een duplicaat van 2026 houdt
 * alle ids; alleen het bord-id en de naam veranderen.
 */

const KLANTEN_BOARD = '1279052045';
const AGENDA_2026 = '5087396949';
const AGENDA_2025 = '1703587792';

const rel = (id: string, ...targets: string[]): DiscoveredColumn => ({
  id,
  type: 'board_relation',
  settings_str: JSON.stringify({ boardIds: targets.map(Number) }),
});

const GEDEELD: readonly DiscoveredColumn[] = [
  rel('board_relation', KLANTEN_BOARD),
  { id: 'tekst_mkn58pt6', type: 'text', settings_str: null },
  { id: 'datum_1', type: 'date', settings_str: null },
];

/** Een kopie van Agenda 2026. */
const kopie = (over: Partial<DiscoveredBoard> = {}): DiscoveredBoard => ({
  id: '6000000001',
  name: 'Agenda 2027',
  state: 'active',
  type: 'board',
  items_count: 3,
  groupIds: [],
  columns: [
    rel('board_relation_mkz4y7tb', TRAINERS_BOARD),
    rel('itg_cotrainers', TRAINERS_BOARD),
    rel('board_relation_mkz4920y', THEMAS_BOARD),
    ...GEDEELD,
  ],
  ...over,
});

const agenda2025: DiscoveredBoard = {
  id: AGENDA_2025,
  name: 'Agenda 2025',
  state: 'active',
  type: 'board',
  items_count: 943,
  groupIds: [],
  columns: [
    rel('board_relation_mkz4w78', TRAINERS_BOARD),
    rel('board_relation_mkz4hjnt', THEMAS_BOARD),
    ...GEDEELD,
  ],
};

describe('classifyAgendaBoard', () => {
  it('herkent een kopie van Agenda 2026, met lead- en co-trainer', () => {
    const uit = classifyAgendaBoard(kopie());
    expect(uit).toEqual({
      kind: 'agenda',
      board: expect.objectContaining({
        boardId: '6000000001',
        naam: 'Agenda 2027',
        jaargang: '2027',
        trainerRelation: 'board_relation_mkz4y7tb',
        coTrainerRelation: 'itg_cotrainers',
        themaRelation: 'board_relation_mkz4920y',
        gearchiveerd: false,
        minimumItems: 0,
      }),
    });
  });

  it('herkent de vorm van 2025: andere ids en geen co-trainerkolom', () => {
    const uit = classifyAgendaBoard(agenda2025);
    if (uit.kind !== 'agenda') {
      throw new Error(`verwacht een agenda, kreeg ${uit.kind}`);
    }
    expect(uit.board.trainerRelation).toBe('board_relation_mkz4w78');
    expect(uit.board.coTrainerRelation).toBeUndefined();
    // Een gemeten bord houdt zijn ondergrens.
    expect(uit.board.minimumItems).toBe(800);
  });

  it('markeert een gearchiveerd bord, zodat het alleen historie krijgt', () => {
    const uit = classifyAgendaBoard(kopie({ state: 'archived' }));
    expect(uit.kind === 'agenda' && uit.board.gearchiveerd).toBe(true);
  });

  it.each([
    ['een subitembord', kopie({ type: 'sub_items_board' })],
    ['een verwijderd bord', kopie({ state: 'deleted' })],
    [
      "een bord zonder relatie naar het Thema's-bord",
      kopie({ columns: [rel('board_relation_mkz4y7tb', TRAINERS_BOARD), ...GEDEELD] }),
    ],
    [
      'een bord waarvan de relaties naar meerdere borden tegelijk wijzen',
      kopie({
        columns: [
          rel('board_relation_mkz4y7tb', TRAINERS_BOARD, '1'),
          rel('board_relation_mkz4920y', THEMAS_BOARD),
          ...GEDEELD,
        ],
      }),
    ],
  ])('negeert %s', (_naam, board) => {
    expect(classifyAgendaBoard(board).kind).toBe('geen-agenda');
  });

  /** Twee trainerkolommen zonder co-trainerkolom: welke de lead is, staat nergens. */
  it('weigert een bord met twee mogelijke leadkolommen', () => {
    const uit = classifyAgendaBoard(
      kopie({
        columns: [
          rel('board_relation_a', TRAINERS_BOARD),
          rel('board_relation_b', TRAINERS_BOARD),
          rel('board_relation_mkz4920y', THEMAS_BOARD),
          ...GEDEELD,
        ],
      })
    );
    expect(uit.kind === 'onbruikbaar' && uit.rejected.reden).toMatch(/leadtrainer/);
  });

  /** Lijkt op een agenda, maar een kolom die de evaluaties lezen ontbreekt. */
  it('weigert een bord zonder IE-codekolom, met de kolom in de reden', () => {
    const uit = classifyAgendaBoard(
      kopie({ columns: kopie().columns.filter((c) => c.id !== 'tekst_mkn58pt6') })
    );
    expect(uit.kind === 'onbruikbaar' && uit.rejected.reden).toMatch(/tekst_mkn58pt6/);
  });
});

describe('resolveAgendaBoards', () => {
  const gevonden = classifyAgendaBoards([
    kopie({ id: AGENDA_2026, name: 'Agenda 2026' }),
    agenda2025,
    kopie(),
  ]);

  it('gebruikt alle gevonden borden, dus ook een nieuwe jaargang', () => {
    expect(resolveAgendaBoards(gevonden, null).boards.map((b) => b.naam)).toEqual([
      'Agenda 2026',
      'Agenda 2025',
      'Agenda 2027',
    ]);
  });

  /** Anders rekent de historie zonder dat jaar door, en verdwijnen zijn cijfers stil. */
  it('weigert als een gemeten bord niet meer gevonden wordt', () => {
    const zonder2025 = classifyAgendaBoards([kopie({ id: AGENDA_2026, name: 'Agenda 2026' })]);
    expect(() => resolveAgendaBoards(zonder2025, null)).toThrow(/1703587792/);
  });

  it('beperkt zich bij de testoverride tot die ene kopie', () => {
    expect(resolveAgendaBoards(gevonden, '6000000001').boards.map((b) => b.boardId)).toEqual([
      '6000000001',
    ]);
  });

  it('weigert een override die geen agendabord is', () => {
    expect(() => resolveAgendaBoards(gevonden, '42')).toThrow(/MONDAY_AGENDA_BOARD_ID/);
  });
});

function client(respond: (document: string, variables?: Record<string, unknown>) => unknown): {
  client: BoardsQueryClient;
  documenten: string[];
} {
  const documenten: string[] = [];
  return {
    documenten,
    client: {
      query: async (document, variables) => {
        documenten.push(document);
        return respond(document, variables);
      },
    },
  };
}

describe('discoverAgendaBoards', () => {
  it('bladert door alle borden en keurt daarna alleen de kandidaten volledig', async () => {
    const vol = Array.from({ length: 100 }, (_, i) => ({
      id: 9000 + i,
      name: `Iets ${i}`,
      state: 'active',
      type: 'board',
      columns: [],
    }));
    const { client: c, documenten } = client((document, variables) => {
      if (document.includes('$page')) {
        return { boards: variables?.page === 1 ? vol : [kopie()] };
      }
      return { boards: [kopie()] };
    });

    const uit = await discoverAgendaBoards(c);

    expect(uit.boards.map((b) => b.boardId)).toEqual(['6000000001']);
    expect(documenten).toHaveLength(3);
    expect(documenten[2]).toContain('boards(ids: $ids)');
  });

  it('weigert een antwoord zonder lijst in plaats van "geen borden" te melden', async () => {
    const { client: c } = client(() => ({ errors: ['kapot'] }));
    await expect(discoverAgendaBoards(c)).rejects.toThrow(/geen lijst/);
  });
});

describe('readAgendaBoard', () => {
  it('keurt één bord, ook als Monday het id als getal teruggeeft', async () => {
    const { client: c } = client(() => ({ boards: [{ ...kopie(), id: 6000000001 }] }));
    const uit = await readAgendaBoard(c, '6000000001');
    expect(uit.kind === 'agenda' && uit.board.boardId).toBe('6000000001');
  });

  it('zegt niet-gevonden, en niet geen-agenda, voor een bord dat het token niet ziet', async () => {
    const { client: c } = client(() => ({ boards: [] }));
    expect((await readAgendaBoard(c, '1')).kind).toBe('niet-gevonden');
  });
});
