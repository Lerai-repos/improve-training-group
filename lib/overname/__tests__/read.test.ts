import { describe, expect, it } from 'vitest';

import { BRIEFING_AGENDA_COLUMNS, OPPORTUNITY_BOARD } from '@lib/briefing/columns';

import { OPPORTUNITY_OVERNAME_COLUMNS } from '../columns';
import { herleesKandidaat, readKandidaten, readOpportunities } from '../read';

import type { Kandidaat } from '../read';

import type { AgendaBoard } from '@lib/evaluations';
import type { BoardMeta, MondayGraphQLClient } from '@lib/monday/graphql-client';

const C = BRIEFING_AGENDA_COLUMNS;
const O = OPPORTUNITY_OVERNAME_COLUMNS;

type Col = BoardMeta['columns'][number];
const col = (id: string, type: string, settings: string | null = null): Col => ({
  id,
  title: id,
  type,
  settings_str: settings,
});

const BORD: AgendaBoard = {
  boardId: '2026',
  naam: 'Agenda 2026',
  jaargang: '2026',
  gearchiveerd: false,
  groupIds: [],
  columnTypes: {},
  trainerRelation: 't',
  themaRelation: 'th',
  klantRelation: 'k',
  ieCode: 'ie',
  minimumItems: 0,
  datum: 'datum_1',
};

const agendaKolommen = (): Col[] => [
  col('datum_1', 'date'),
  col(C.opportunity, 'board_relation', `{"boardIds":[${OPPORTUNITY_BOARD}]}`),
  col(C.voorbereidend, 'status'),
  col(C.huiswerk, 'status'),
  col(C.duurcategorie, 'dropdown'),
];

const rij = (
  id: string,
  cells: Record<string, object>,
  name = `training ${id}`
): { id: string; name: string; updated_at: string; column_values: object[] } => ({
  id,
  name,
  updated_at: 'x',
  column_values: Object.entries(cells).map(([cid, v]) => ({ id: cid, ...v })),
});

interface FakeOptions {
  readonly columns?: Col[];
  readonly items?: readonly unknown[];
  /** Rijen per pagina; standaard alles op één pagina. */
  readonly pagina?: number;
  readonly opportunityItems?: readonly { id: string }[];
  /** Wat `items(ids:)` teruggeeft voor een agenda-item, bij de herlezing. */
  readonly agendaItems?: readonly { id: string }[];
}

function fakeClient(options: FakeOptions = {}): MondayGraphQLClient & { vragen: string[] } {
  const vragen: string[] = [];
  return {
    vragen,
    // Testdubbel: de fake geeft terug wat de test erin stopte, in de vorm die de lezer verwacht.
    query: async <T>(document: string, variables?: Record<string, unknown>): Promise<T> => {
      vragen.push(JSON.stringify(variables));
      if (document.includes('items_page')) {
        // Het bord in pagina's van `pagina` rijen; de cursor is de index van de volgende rij.
        const alle = options.items ?? [];
        const grootte = options.pagina ?? alle.length;
        const vanaf = typeof variables?.cursor === 'string' ? Number(variables.cursor) : 0;
        const tot = vanaf + grootte;
        const page = {
          cursor: tot < alle.length ? String(tot) : null,
          items: alle.slice(vanaf, tot),
        };
        const eerste = { boards: [{ items_page: page }] };
        return (document.includes('next_items_page') ? { next_items_page: page } : eerste) as T;
      }
      const ruw = variables?.ids;
      const gevraagd = new Set(Array.isArray(ruw) ? ruw.map(String) : []);
      const items = [...(options.opportunityItems ?? []), ...(options.agendaItems ?? [])].filter(
        (it) => gevraagd.has(it.id)
      );
      return { items } as T;
    },
    preflight: async () => ({
      account: { id: '1', name: 'x' },
      reportedVersion: null,
      supportedVersions: [],
    }),
    getSchema: async (ids) =>
      ids.map((id) => ({
        id,
        name: id,
        groups: [],
        items_count: (options.items ?? []).length,
        columns:
          id === OPPORTUNITY_BOARD
            ? [col(O.voorbereidend, 'status'), col(O.huiswerk, 'status'), col(O.cyclus, 'status')]
            : (options.columns ?? agendaKolommen()),
      })),
    // De overname bladert zelf; de gehekte lezer hoort hier niet gebruikt te worden.
    fetchBoardItems: async () => {
      throw new Error('board changed during pagination');
    },
    lastReportedVersion: () => null,
  };
}

describe('readKandidaten', () => {
  it('geeft de komende trainingen met Opportunity, met de stand van de drie cellen', async () => {
    const client = fakeClient({
      items: [
        rij('a', {
          datum_1: { date: '2026-10-01' },
          [C.opportunity]: { linked_item_ids: [11] },
          [C.voorbereidend]: { index: 5 },
          [C.huiswerk]: { index: null },
          [C.duurcategorie]: { values: [{ id: '2' }, { id: 6 }] },
        }),
        rij('gisteren', {
          datum_1: { date: '2026-09-17' },
          [C.opportunity]: { linked_item_ids: [11] },
        }),
        rij('zonder-opp', {
          datum_1: { date: '2026-10-01' },
          [C.opportunity]: { linked_item_ids: [] },
        }),
        rij('zonder-datum', {
          datum_1: { date: null },
          [C.opportunity]: { linked_item_ids: [11] },
        }),
      ],
    });
    const uit = await readKandidaten(client, BORD, '2026-09-18');
    expect(uit).toEqual([
      {
        itemId: 'a',
        boardId: '2026',
        naam: 'training a',
        datum: '2026-10-01',
        opportunityItemId: '11',
        agenda: {
          voorbereidend: 5,
          huiswerk: null,
          duurcategorie: [2, 6],
          kolommen: new Set([C.voorbereidend, C.duurcategorie, C.huiswerk]),
        },
      },
    ]);
  });

  it("bladert door alle pagina's, en een bewerking tijdens het bladeren houdt de scan niet tegen", async () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      rij(id, { datum_1: { date: '2026-10-01' }, [C.opportunity]: { linked_item_ids: [11] } })
    );
    const client = fakeClient({ items, pagina: 2 });
    const uit = await readKandidaten(client, BORD, '2026-09-18');
    expect(uit.map((k) => k.itemId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it("een rij die op twee pagina's opduikt telt één keer", async () => {
    const a = rij('a', {
      datum_1: { date: '2026-10-01' },
      [C.opportunity]: { linked_item_ids: [11] },
    });
    const client = fakeClient({ items: [a, a], pagina: 1 });
    expect(await readKandidaten(client, BORD, '2026-09-18')).toHaveLength(1);
  });

  it('vandaag telt nog mee', async () => {
    const client = fakeClient({
      items: [
        rij('a', { datum_1: { date: '2026-09-18' }, [C.opportunity]: { linked_item_ids: ['11'] } }),
      ],
    });
    expect(await readKandidaten(client, BORD, '2026-09-18')).toHaveLength(1);
  });

  it('zonder Huisw. opdr. op het bord ontbreekt die kolom in `kolommen`', async () => {
    const client = fakeClient({
      columns: agendaKolommen().filter((c) => c.id !== C.huiswerk),
      items: [
        rij('a', { datum_1: { date: '2026-10-01' }, [C.opportunity]: { linked_item_ids: [11] } }),
      ],
    });
    const [eerste] = await readKandidaten(client, BORD, '2026-09-18');
    expect(eerste?.agenda.kolommen.has(C.huiswerk)).toBe(false);
  });

  it('werpt als een verplichte kolom weg is of de relatie naar een ander bord wijst', async () => {
    await expect(
      readKandidaten(
        fakeClient({ columns: agendaKolommen().filter((c) => c.id !== C.voorbereidend) }),
        BORD,
        '2026-09-18'
      )
    ).rejects.toThrow(C.voorbereidend);
    await expect(
      readKandidaten(
        fakeClient({
          columns: agendaKolommen().map((c) =>
            c.id === C.opportunity ? col(C.opportunity, 'board_relation', '{"boardIds":[999]}') : c
          ),
        }),
        BORD,
        '2026-09-18'
      )
    ).rejects.toThrow(C.opportunity);
    await expect(
      readKandidaten(
        fakeClient({
          columns: agendaKolommen().map((c) => (c.id === C.huiswerk ? col(C.huiswerk, 'text') : c)),
        }),
        BORD,
        '2026-09-18'
      )
    ).rejects.toThrow(C.huiswerk);
  });
});

describe('readOpportunities', () => {
  it('leest de drie indexen, in porties van 25', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `o${i}`);
    const client = fakeClient({
      opportunityItems: ids.map((id) =>
        rij(id, {
          [O.voorbereidend]: { index: 0 },
          [O.huiswerk]: { index: null },
          [O.cyclus]: { index: 6 },
        })
      ),
    });
    const uit = await readOpportunities(client, ids);
    expect(uit.size).toBe(30);
    expect(uit.get('o29')).toEqual({ voorbereidend: 0, huiswerk: null, cyclus: 6 });
    expect(client.vragen).toHaveLength(2);
  });

  it('werpt als een van de drie kolommen op het Opportunitybord ontbreekt', async () => {
    const client = fakeClient();
    client.getSchema = async (ids) =>
      ids.map((id) => ({
        id,
        name: id,
        groups: [],
        items_count: 0,
        columns: [col(O.voorbereidend, 'status')],
      }));
    await expect(readOpportunities(client, ['o1'])).rejects.toThrow(O.cyclus);
  });
});

describe('herleesKandidaat', () => {
  const RIJ: Kandidaat = {
    itemId: 'a',
    boardId: '2026',
    naam: 'training a',
    datum: '2026-10-01',
    opportunityItemId: '11',
    agenda: {
      voorbereidend: null,
      huiswerk: null,
      duurcategorie: [],
      kolommen: new Set([C.voorbereidend, C.duurcategorie, C.huiswerk]),
    },
  };
  const opp = rij('11', {
    [O.voorbereidend]: { index: 1 },
    [O.huiswerk]: { index: 1 },
    [O.cyclus]: { index: 3 },
  });
  const agendaItem = (over: Record<string, object> = {}): ReturnType<typeof rij> =>
    rij('a', {
      [C.opportunity]: { linked_item_ids: [11] },
      [C.voorbereidend]: { index: null },
      [C.huiswerk]: { index: 6 },
      [C.duurcategorie]: { values: [] },
      ...over,
    });

  it('geeft de stand van training en Opportunity zoals ze nu zijn', async () => {
    const client = fakeClient({ agendaItems: [agendaItem()], opportunityItems: [opp] });
    expect(await herleesKandidaat(client, RIJ)).toEqual({
      agenda: {
        voorbereidend: null,
        huiswerk: 6,
        duurcategorie: [],
        kolommen: RIJ.agenda.kolommen,
      },
      stand: { voorbereidend: 1, huiswerk: 1, cyclus: 3 },
    });
  });

  it('is null als de training weg is, omgehangen is, of de Opportunity niet meer bestaat', async () => {
    expect(await herleesKandidaat(fakeClient({ opportunityItems: [opp] }), RIJ)).toBeNull();
    expect(
      await herleesKandidaat(
        fakeClient({
          agendaItems: [agendaItem({ [C.opportunity]: { linked_item_ids: [99] } })],
          opportunityItems: [opp],
        }),
        RIJ
      )
    ).toBeNull();
    expect(await herleesKandidaat(fakeClient({ agendaItems: [agendaItem()] }), RIJ)).toBeNull();
  });

  it('werpt als een doelkolom in het antwoord ontbreekt, in plaats van hem als leeg te lezen', async () => {
    const zonder = rij('a', {
      [C.opportunity]: { linked_item_ids: [11] },
      [C.voorbereidend]: { index: null },
      [C.duurcategorie]: { values: [] },
    });
    await expect(
      herleesKandidaat(fakeClient({ agendaItems: [zonder], opportunityItems: [opp] }), RIJ)
    ).rejects.toThrow(C.huiswerk);
  });
});
