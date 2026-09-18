import { describe, expect, it } from 'vitest';

import { readCyclusKandidaten, type CyclusBoard, type CyclusReader } from '../cyclus-read';

/**
 * Het ophalen van de sessies onder één Opportunity.
 *
 * De regel zelf staat in `cyclus.test.ts`; hier gaat het om wat stil mis kan gaan: een bord
 * dat niet doorzocht wordt, de relatie-ids van het verkeerde jaar, of een verdwenen kolom die
 * leest als "geen cyclus".
 */

const BORD_2026: CyclusBoard = {
  boardId: '2026',
  gearchiveerd: false,
  trainerRelation: 'lead26',
  coTrainerRelation: 'itg_cotrainers',
  themaRelation: 'thema26',
  columnTypes: {
    board_relation: 'board_relation',
    dropdown_mkmvzp85: 'dropdown',
    tekst_mkmxrqwc: 'text',
    datum_1: 'date',
    dup__of_workshop: 'text',
    tekst7: 'text',
    deelnemersaantal__1: 'text',
    thema26: 'board_relation',
    lead26: 'board_relation',
    itg_cotrainers: 'board_relation',
  },
};

const BORD_2025: CyclusBoard = {
  boardId: '2025',
  gearchiveerd: true,
  trainerRelation: 'lead25',
  themaRelation: 'thema25',
  columnTypes: {
    ...BORD_2026.columnTypes,
    thema25: 'board_relation',
    lead25: 'board_relation',
  },
};

interface Item {
  id: string;
  datum: string;
  cyclus?: boolean;
  lead?: string[];
}

const itemVoor = (bord: CyclusBoard, item: Item) => ({
  id: item.id,
  column_values: [
    { id: 'board_relation', text: null, linked_item_ids: ['77'] },
    { id: 'dropdown_mkmvzp85', text: '', values: item.cyclus === false ? [] : [{ id: 6 }] },
    { id: 'tekst_mkmxrqwc', text: 'Moeilijke gesprekken' },
    { id: 'datum_1', text: '', date: item.datum },
    { id: 'dup__of_workshop', text: '09:00 - 13:00' },
    { id: 'tekst7', text: 'Almere' },
    { id: 'deelnemersaantal__1', text: '12' },
    { id: bord.themaRelation, text: null, linked_item_ids: ['t1'] },
    { id: bord.trainerRelation, text: null, linked_item_ids: item.lead ?? ['lead'] },
    ...(bord.coTrainerRelation === undefined
      ? []
      : [{ id: bord.coTrainerRelation, text: null, linked_item_ids: [] }]),
  ],
});

function client(perBord: Record<string, Item[]>): CyclusReader & { documenten: string[] } {
  const documenten: string[] = [];
  const borden = [BORD_2026, BORD_2025];
  return {
    documenten,
    async query<T>(document: string, variables?: Record<string, unknown>): Promise<T> {
      documenten.push(document);
      if (document.includes('items(ids: $ids)')) {
        const ids = Array.isArray(variables?.ids) ? variables.ids : [];
        const namen: unknown = { items: ids.map((id) => ({ id, name: `Trainer ${String(id)}` })) };
        // Test-dubbel: precies de vorm die de namenquery verwacht.
        return namen as T;
      }
      const gevraagd = variables?.board;
      const id = Array.isArray(gevraagd) ? String(gevraagd[0]) : '';
      const bord = borden.find((b) => b.boardId === id);
      if (bord === undefined) {
        throw new Error(`onverwacht bord ${id}`);
      }
      expect(variables?.opp).toEqual([77]);
      const antwoord: unknown = {
        boards: [
          {
            items_page: {
              cursor: null,
              items: (perBord[id] ?? []).map((item) => itemVoor(bord, item)),
            },
          },
        ],
      };
      // Test-dubbel: de vorm hierboven is precies wat de lezer als `T` verwacht.
      return antwoord as T;
    },
  };
}

const OPPORTUNITY = '77';

describe('readCyclusKandidaten', () => {
  it('vindt sessies op elk bord, met de relatie-ids van dat bord', async () => {
    const monday = client({
      '2025': [{ id: 'a', datum: '2025-12-01' }],
      '2026': [{ id: 'b', datum: '2026-01-10' }],
    });
    const kandidaten = await readCyclusKandidaten(monday, OPPORTUNITY, [BORD_2026, BORD_2025]);
    expect(
      kandidaten
        .map((k) => [k.itemId, k.boardId, k.gearchiveerd, k.trainerNamen])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    ).toEqual([
      ['a', '2025', true, 'Trainer lead'],
      ['b', '2026', false, 'Trainer lead'],
    ]);
    expect(monday.documenten.some((d) => d.includes('"lead25"'))).toBe(true);
    expect(monday.documenten.some((d) => d.includes('"lead26"'))).toBe(true);
  });

  it('zoekt niet zonder Opportunity', async () => {
    const monday = client({});
    expect(await readCyclusKandidaten(monday, null, [BORD_2026])).toEqual([]);
    expect(monday.documenten).toEqual([]);
  });

  it('werpt als een bord de cycluskolom mist, in plaats van "geen cyclus" te lezen', async () => {
    const zonder: CyclusBoard = {
      ...BORD_2026,
      columnTypes: { ...BORD_2026.columnTypes, dropdown_mkmvzp85: 'text' },
    };
    await expect(
      readCyclusKandidaten(client({ '2026': [{ id: 'b', datum: '2026-01-10' }] }), OPPORTUNITY, [
        zonder,
      ])
    ).rejects.toThrow(/dropdown_mkmvzp85/);
  });

  it('werpt als Monday geen pagina teruggeeft', async () => {
    const leeg: CyclusReader = {
      async query<T>(): Promise<T> {
        const antwoord: unknown = { boards: [] };
        // Test-dubbel: een antwoord zonder bord.
        return antwoord as T;
      },
    };
    await expect(readCyclusKandidaten(leeg, OPPORTUNITY, [BORD_2026])).rejects.toThrow(
      /geen leesbare pagina/
    );
  });
});
