import { describe, expect, it } from 'vitest';

import { BRIEFING_AGENDA_COLUMNS, DUURCATEGORIE_CYCLUS } from '@lib/briefing/columns';

import { AGENDA_LABELS, OPPORTUNITY_LABELS } from '../columns';
import { bepaalOvername } from '../regel';

import type { AgendaStand, OpportunityStand } from '../regel';

const C = BRIEFING_AGENDA_COLUMNS;

const leeg: AgendaStand = {
  voorbereidend: null,
  huiswerk: null,
  duurcategorie: [],
  kolommen: new Set([C.voorbereidend, C.huiswerk, C.duurcategorie]),
};

const opp = (over: Partial<OpportunityStand> = {}): OpportunityStand => ({
  voorbereidend: null,
  huiswerk: null,
  cyclus: null,
  ...over,
});

describe('bepaalOvername', () => {
  it('vult lege agendacellen met het antwoord van de Opportunity', () => {
    const uit = bepaalOvername(
      leeg,
      opp({
        voorbereidend: OPPORTUNITY_LABELS.voorbereidend.wel,
        huiswerk: OPPORTUNITY_LABELS.huiswerk.wel,
        cyclus: 1, // 2x4u
      })
    );
    expect(uit.conflicten).toEqual([]);
    expect(uit.schrijf).toEqual({
      [C.voorbereidend]: { index: AGENDA_LABELS.voorbereidend.wel },
      [C.huiswerk]: { index: AGENDA_LABELS.huiswerk.wel },
      [C.duurcategorie]: { ids: [DUURCATEGORIE_CYCLUS] },
    });
  });

  it('"geen" op de Opportunity wordt "geen (deze sessie)" op de agenda', () => {
    const uit = bepaalOvername(
      leeg,
      opp({
        voorbereidend: OPPORTUNITY_LABELS.voorbereidend.geen,
        huiswerk: OPPORTUNITY_LABELS.huiswerk.geen,
      })
    );
    expect(uit.schrijf).toEqual({
      [C.voorbereidend]: { index: AGENDA_LABELS.voorbereidend.geen },
      [C.huiswerk]: { index: AGENDA_LABELS.huiswerk.geen },
    });
  });

  it('elke cyclusvariant wordt het ene agendalabel; "Nee" schrijft niets', () => {
    for (const variant of [0, 1, 2, 3, 4, 7]) {
      expect(bepaalOvername(leeg, opp({ cyclus: variant })).schrijf).toEqual({
        [C.duurcategorie]: { ids: [DUURCATEGORIE_CYCLUS] },
      });
    }
    expect(bepaalOvername(leeg, opp({ cyclus: OPPORTUNITY_LABELS.cyclus.nee })).schrijf).toEqual(
      {}
    );
    expect(bepaalOvername(leeg, opp({ cyclus: OPPORTUNITY_LABELS.cyclus.leeg })).schrijf).toEqual(
      {}
    );
  });

  it('een lege Opportunity levert niets op', () => {
    expect(bepaalOvername(leeg, opp())).toEqual({ schrijf: {}, conflicten: [] });
  });

  it('het grijze standaardlabel op Voorb. opdr. telt als leeg', () => {
    const uit = bepaalOvername(
      { ...leeg, voorbereidend: AGENDA_LABELS.voorbereidend.onbeantwoord },
      opp({ voorbereidend: OPPORTUNITY_LABELS.voorbereidend.wel })
    );
    expect(uit.schrijf).toEqual({
      [C.voorbereidend]: { index: AGENDA_LABELS.voorbereidend.wel },
    });
  });

  it('overschrijft nooit wat er al staat: gelijk is klaar, anders een conflict', () => {
    const gelijk = bepaalOvername(
      {
        ...leeg,
        voorbereidend: AGENDA_LABELS.voorbereidend.wel,
        huiswerk: AGENDA_LABELS.huiswerk.geen,
        duurcategorie: [DUURCATEGORIE_CYCLUS],
      },
      opp({
        voorbereidend: OPPORTUNITY_LABELS.voorbereidend.wel,
        huiswerk: OPPORTUNITY_LABELS.huiswerk.geen,
        cyclus: 3,
      })
    );
    expect(gelijk).toEqual({ schrijf: {}, conflicten: [] });

    const anders = bepaalOvername(
      {
        ...leeg,
        voorbereidend: AGENDA_LABELS.voorbereidend.geen,
        huiswerk: AGENDA_LABELS.huiswerk.wel,
        duurcategorie: [2], // workshop
      },
      opp({
        voorbereidend: OPPORTUNITY_LABELS.voorbereidend.wel,
        huiswerk: OPPORTUNITY_LABELS.huiswerk.geen,
        cyclus: 1,
      })
    );
    expect(anders.schrijf).toEqual({});
    expect(anders.conflicten.map((c) => c.veld).sort()).toEqual([
      'cyclus',
      'huiswerk',
      'voorbereidend',
    ]);
  });

  it('"Nee" op de Opportunity tegenover het cycluslabel op de agenda is een conflict', () => {
    const uit = bepaalOvername(
      { ...leeg, duurcategorie: [DUURCATEGORIE_CYCLUS] },
      opp({ cyclus: OPPORTUNITY_LABELS.cyclus.nee })
    );
    expect(uit.schrijf).toEqual({});
    expect(uit.conflicten).toEqual([
      { veld: 'cyclus', opportunity: 'Nee', agenda: 'trainingscyclus (2x4/2x7)' },
    ]);
  });

  it('een agendalabel dat naast het cycluslabel staat is geen conflict', () => {
    const uit = bepaalOvername(
      { ...leeg, duurcategorie: [DUURCATEGORIE_CYCLUS, 4] },
      opp({ cyclus: 1 })
    );
    expect(uit).toEqual({ schrijf: {}, conflicten: [] });
  });

  it('slaat een kolom over die het bord niet heeft (Agenda 2025 zonder Huisw. opdr.)', () => {
    const uit = bepaalOvername(
      { ...leeg, kolommen: new Set([C.voorbereidend, C.duurcategorie]) },
      opp({
        voorbereidend: OPPORTUNITY_LABELS.voorbereidend.wel,
        huiswerk: OPPORTUNITY_LABELS.huiswerk.wel,
      })
    );
    expect(uit.schrijf).toEqual({
      [C.voorbereidend]: { index: AGENDA_LABELS.voorbereidend.wel },
    });
    expect(uit.conflicten).toEqual([]);
  });

  it('een onbekende index op de Opportunity telt als onbeantwoord', () => {
    expect(bepaalOvername(leeg, opp({ voorbereidend: 7, huiswerk: 9 }))).toEqual({
      schrijf: {},
      conflicten: [],
    });
  });
});
