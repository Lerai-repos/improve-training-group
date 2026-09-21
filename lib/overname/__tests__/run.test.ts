import { describe, expect, it } from 'vitest';

import { BRIEFING_AGENDA_COLUMNS, DUURCATEGORIE_CYCLUS } from '@lib/briefing/columns';

import { AGENDA_LABELS, OPPORTUNITY_LABELS } from '../columns';
import { runOvername } from '../run';

import type { AgendaBoardSet } from '@lib/evaluations';
import type { Kandidaat } from '../read';
import type { OpportunityStand } from '../regel';
import type { OvernameDeps, Schrijfactie } from '../run';

const C = BRIEFING_AGENDA_COLUMNS;

const bord = (boardId: string, gearchiveerd = false): AgendaBoardSet['boards'][number] => ({
  boardId,
  naam: `Agenda ${boardId}`,
  jaargang: boardId,
  gearchiveerd,
  groupIds: [],
  columnTypes: {},
  trainerRelation: 't',
  themaRelation: 'th',
  klantRelation: 'k',
  ieCode: 'ie',
  minimumItems: 0,
  datum: 'd',
});

const kandidaat = (over: Partial<Kandidaat> = {}): Kandidaat => ({
  itemId: 'i1',
  boardId: '2026',
  naam: 'COA',
  datum: '2027-02-03',
  opportunityItemId: 'o1',
  agenda: {
    voorbereidend: null,
    huiswerk: null,
    duurcategorie: [],
    kolommen: new Set([C.voorbereidend, C.huiswerk, C.duurcategorie]),
  },
  ...over,
});

const cyclusOpp: OpportunityStand = {
  voorbereidend: OPPORTUNITY_LABELS.voorbereidend.geen,
  huiswerk: OPPORTUNITY_LABELS.huiswerk.wel,
  cyclus: 3,
};

interface FakeOptions {
  readonly kandidaten?: Readonly<Record<string, readonly Kandidaat[] | Error>>;
  readonly opportunities?: ReadonlyMap<string, OpportunityStand>;
  readonly dryRun?: boolean;
  readonly schrijfFout?: string;
  /** Wat de herlezing vlak voor het schrijven teruggeeft; standaard: niets veranderd. */
  readonly herlees?: OvernameDeps['herlees'];
}

function fake(options: FakeOptions = {}): { deps: OvernameDeps; geschreven: Schrijfactie[] } {
  const geschreven: Schrijfactie[] = [];
  const deps: OvernameDeps = {
    readAgendaBoards: async () => ({
      boards: [bord('2026'), bord('2025', true)],
      rejected: [],
    }),
    readKandidaten: async (board) => {
      const uit = options.kandidaten?.[board.boardId] ?? [];
      if (uit instanceof Error) {
        throw uit;
      }
      return uit;
    },
    readOpportunities: async (ids) =>
      new Map([...(options.opportunities ?? new Map())].filter(([id]) => ids.includes(id))),
    herlees:
      options.herlees ??
      (async (rij) => {
        const stand = options.opportunities?.get(rij.opportunityItemId);
        return stand === undefined ? null : { agenda: rij.agenda, stand };
      }),
    writer:
      options.dryRun === true
        ? null
        : async (actie) => {
            if (options.schrijfFout !== undefined && actie.itemId === options.schrijfFout) {
              throw new Error('Monday zegt nee');
            }
            geschreven.push(actie);
          },
  };
  return { deps, geschreven };
}

describe('runOvername', () => {
  it('leest alleen de levende borden en schrijft de lege cellen', async () => {
    const { deps, geschreven } = fake({
      kandidaten: {
        '2026': [kandidaat()],
        '2025': [kandidaat({ itemId: 'oud', boardId: '2025' })],
      },
      opportunities: new Map([['o1', cyclusOpp]]),
    });
    const report = await runOvername(deps);
    expect(report.borden).toEqual(['Agenda 2026']);
    expect(geschreven).toEqual([
      {
        boardId: '2026',
        itemId: 'i1',
        naam: 'COA',
        waarden: {
          [C.voorbereidend]: { index: AGENDA_LABELS.voorbereidend.geen },
          [C.huiswerk]: { index: AGENDA_LABELS.huiswerk.wel },
          [C.duurcategorie]: { ids: [DUURCATEGORIE_CYCLUS] },
        },
      },
    ]);
    expect(report.geschreven).toEqual(geschreven);
    expect(report.trainingen).toBe(1);
    expect(report.metAntwoord).toBe(1);
    expect(report.conflicten).toEqual([]);
    expect(report.mislukt).toEqual([]);
  });

  it('een droogloop berekent hetzelfde en schrijft niets', async () => {
    const { deps, geschreven } = fake({
      kandidaten: { '2026': [kandidaat()] },
      opportunities: new Map([['o1', cyclusOpp]]),
      dryRun: true,
    });
    const report = await runOvername(deps);
    expect(report.dryRun).toBe(true);
    expect(report.geschreven).toHaveLength(1);
    expect(geschreven).toEqual([]);
  });

  it('een training zonder antwoord op de Opportunity, of zonder verschil, wordt niet aangeraakt', async () => {
    const { deps, geschreven } = fake({
      kandidaten: {
        '2026': [
          kandidaat({ itemId: 'zonder', opportunityItemId: 'o-leeg' }),
          kandidaat({
            itemId: 'gelijk',
            agenda: {
              voorbereidend: AGENDA_LABELS.voorbereidend.geen,
              huiswerk: AGENDA_LABELS.huiswerk.wel,
              duurcategorie: [DUURCATEGORIE_CYCLUS],
              kolommen: new Set([C.voorbereidend, C.huiswerk, C.duurcategorie]),
            },
          }),
        ],
      },
      opportunities: new Map([
        ['o1', cyclusOpp],
        ['o-leeg', { voorbereidend: null, huiswerk: null, cyclus: null }],
      ]),
    });
    const report = await runOvername(deps);
    expect(geschreven).toEqual([]);
    expect(report.trainingen).toBe(2);
    expect(report.metAntwoord).toBe(1);
  });

  it('meldt conflicten per training en schrijft de rest van die training wél', async () => {
    const { deps, geschreven } = fake({
      kandidaten: {
        '2026': [
          kandidaat({
            agenda: {
              voorbereidend: AGENDA_LABELS.voorbereidend.wel,
              huiswerk: null,
              duurcategorie: [],
              kolommen: new Set([C.voorbereidend, C.huiswerk, C.duurcategorie]),
            },
          }),
        ],
      },
      opportunities: new Map([['o1', cyclusOpp]]),
    });
    const report = await runOvername(deps);
    expect(report.conflicten).toEqual([
      {
        boardId: '2026',
        itemId: 'i1',
        naam: 'COA',
        conflicten: [{ veld: 'voorbereidend', opportunity: 'Geen', agenda: 'Wel' }],
      },
    ]);
    expect(geschreven.map((g) => Object.keys(g.waarden))).toEqual([[C.huiswerk, C.duurcategorie]]);
  });

  it('een bord dat niet te lezen is houdt de andere niet op, en staat in het rapport', async () => {
    const { deps, geschreven } = fake({ opportunities: new Map([['o1', cyclusOpp]]) });
    const report = await runOvername({
      ...deps,
      readAgendaBoards: async () => ({ boards: [bord('2026'), bord('2027')], rejected: [] }),
      readKandidaten: async (board) =>
        board.boardId === '2026'
          ? Promise.reject(new Error('kolom weg'))
          : [kandidaat({ boardId: '2027' })],
    });
    expect(report.mislukt).toEqual([{ bord: 'Agenda 2026', fout: 'kolom weg' }]);
    expect(geschreven).toHaveLength(1);
  });

  it('een mislukte schrijfactie staat in het rapport en stopt de rest niet', async () => {
    const { deps, geschreven } = fake({
      kandidaten: { '2026': [kandidaat({ itemId: 'a' }), kandidaat({ itemId: 'b' })] },
      opportunities: new Map([['o1', cyclusOpp]]),
      schrijfFout: 'a',
    });
    const report = await runOvername(deps);
    expect(report.mislukt).toEqual([
      { bord: 'Agenda 2026', training: 'a', fout: 'Monday zegt nee' },
    ]);
    expect(geschreven.map((g) => g.itemId)).toEqual(['b']);
    expect(report.geschreven.map((g) => g.itemId)).toEqual(['b']);
  });

  it('herleest de training vlak voor het schrijven en schrijft alleen wat dan nog leeg is', async () => {
    const { deps, geschreven } = fake({
      kandidaten: { '2026': [kandidaat()] },
      opportunities: new Map([['o1', cyclusOpp]]),
      // Tussen de scan en het schrijven vulde iemand Huisw. opdr. zelf in.
      herlees: async (rij) => ({
        agenda: { ...rij.agenda, huiswerk: AGENDA_LABELS.huiswerk.geen },
        stand: cyclusOpp,
      }),
    });
    const report = await runOvername(deps);
    expect(geschreven.map((g) => Object.keys(g.waarden))).toEqual([
      [C.voorbereidend, C.duurcategorie],
    ]);
    // Wat de mens intussen koos spreekt de Opportunity tegen: melden, niet overschrijven.
    expect(report.conflicten.map((c) => c.conflicten.map((x) => x.veld))).toEqual([['huiswerk']]);
  });

  it('gebruikt bij het schrijven het antwoord van de Opportunity zoals het dán is', async () => {
    const { deps, geschreven } = fake({
      kandidaten: { '2026': [kandidaat()] },
      opportunities: new Map([['o1', cyclusOpp]]),
      herlees: async (rij) => ({
        agenda: rij.agenda,
        stand: { voorbereidend: null, huiswerk: OPPORTUNITY_LABELS.huiswerk.geen, cyclus: null },
      }),
    });
    await runOvername(deps);
    expect(geschreven.map((g) => g.waarden)).toEqual([
      { [C.huiswerk]: { index: AGENDA_LABELS.huiswerk.geen } },
    ]);
  });

  it('schrijft niets als de training intussen weg is, omgehangen, of alles al gevuld is', async () => {
    for (const herlees of [
      async () => null,
      async (rij: Kandidaat) => ({
        agenda: {
          ...rij.agenda,
          voorbereidend: AGENDA_LABELS.voorbereidend.geen,
          huiswerk: AGENDA_LABELS.huiswerk.wel,
          duurcategorie: [DUURCATEGORIE_CYCLUS],
        },
        stand: cyclusOpp,
      }),
    ]) {
      const { deps, geschreven } = fake({
        kandidaten: { '2026': [kandidaat()] },
        opportunities: new Map([['o1', cyclusOpp]]),
        herlees,
      });
      const report = await runOvername(deps);
      expect(geschreven).toEqual([]);
      expect(report.geschreven).toEqual([]);
      expect(report.mislukt).toEqual([]);
    }
  });

  it('een mislukte herlezing staat in het rapport en er wordt niet geschreven', async () => {
    const { deps, geschreven } = fake({
      kandidaten: { '2026': [kandidaat()] },
      opportunities: new Map([['o1', cyclusOpp]]),
      herlees: async () => {
        throw new Error('Monday hapert');
      },
    });
    const report = await runOvername(deps);
    expect(geschreven).toEqual([]);
    expect(report.mislukt).toEqual([
      { bord: 'Agenda 2026', training: 'i1', fout: 'Monday hapert' },
    ]);
  });

  it('een droogloop herleest niet', async () => {
    let herlezen = 0;
    const { deps } = fake({
      kandidaten: { '2026': [kandidaat()] },
      opportunities: new Map([['o1', cyclusOpp]]),
      dryRun: true,
      herlees: async () => {
        herlezen += 1;
        return null;
      },
    });
    const report = await runOvername(deps);
    expect(herlezen).toBe(0);
    expect(report.geschreven).toHaveLength(1);
  });

  it('zonder kandidaten wordt de Opportunity niet eens bevraagd', async () => {
    let bevraagd = false;
    const { deps } = fake();
    await runOvername({
      ...deps,
      readOpportunities: async () => {
        bevraagd = true;
        return new Map();
      },
    });
    expect(bevraagd).toBe(false);
  });
});
