import { describe, expect, it } from 'vitest';

import {
  MAX_LABELS,
  STATUS_KLEUR,
  controleerNa,
  leesStatusOpties,
  ontbrekend,
  planKeuzelijst,
} from '../keuzelijst';
import { heeftFouten, syncKeuzelijsten } from '../keuzelijst-sync';

import type { StatusLabelInvoer, StatusOptie } from '../keuzelijst';
import type { KeuzelijstDeps, KeuzelijstDoel } from '../keuzelijst-sync';

/** De kolom `Label` op het Opportunitybord, zoals Monday hem op 13-Oct-2026 teruggaf. */
const OPPORTUNITY = {
  labels: [
    { id: 0, color: 7, label: 'TT', is_done: false, is_deactivated: false, hex: '#579bfc' },
    { id: 1, color: 107, label: 'IT', is_done: true, is_deactivated: false, hex: '#225091' },
    { id: 2, color: 19, label: 'WJ', is_done: false, is_deactivated: false, hex: '#ff6d3b' },
    { id: 3, color: 1, label: 'FV', is_done: false, is_deactivated: false, hex: '#00c875' },
    { id: 4, color: 15, label: 'JE', is_done: false, is_deactivated: false, hex: '#9cd326' },
    { id: 5, color: 5, label: '', index: 0, is_done: false, is_deactivated: false, hex: '#c4c4c4' },
    {
      id: 6,
      color: 105,
      label: 'SST',
      index: 0,
      is_done: false,
      is_deactivated: false,
      hex: '#9aadbd',
    },
    { id: 7, color: 6, label: 'WorkJoy', is_done: false, is_deactivated: true, hex: '#037f4c' },
    {
      id: 8,
      color: 8,
      label: 'Feedbacktrainer',
      is_done: false,
      is_deactivated: false,
      hex: '#cab641',
    },
    {
      id: 9,
      color: 9,
      label: 'Incompany Trainer',
      is_done: false,
      is_deactivated: false,
      hex: '#ffcb00',
    },
    { id: 10, color: 11, label: 'CC', is_done: false, is_deactivated: false, hex: '#bb3354' },
    {
      id: 11,
      color: 10,
      label: 'ST - StressTrainer',
      is_done: false,
      is_deactivated: false,
      hex: '#333333',
    },
    {
      id: 12,
      color: 12,
      label: 'Company Cursus',
      is_done: false,
      is_deactivated: false,
      hex: '#ff007f',
    },
    { id: 13, color: 13, label: 'CP', is_done: false, is_deactivated: false, hex: '#ff5ac4' },
    { id: 14, color: 14, label: 'Email', is_done: false, is_deactivated: false, hex: '#784bd1' },
    {
      id: 15,
      color: 4,
      label: 'TMT',
      index: 1,
      is_done: false,
      is_deactivated: false,
      hex: '#9d50dd',
    },
    {
      id: 16,
      color: 16,
      label: 'Communicatie Plus',
      is_done: false,
      is_deactivated: false,
      hex: '#66ccff',
    },
    { id: 17, color: 103, label: 'ITG', is_done: false, is_deactivated: false, hex: '#ffadad' },
  ],
};

const opties = (): readonly StatusOptie[] => leesStatusOpties(OPPORTUNITY, 'test');

/** De tien labels die het Labels-bord nu kent. */
const BORD = ['IT', 'JE', 'TT', 'FV', 'SST', 'WJ', 'CC', 'CP', 'FT', 'ITG'];

describe('leesStatusOpties', () => {
  it('leest elk label, ook zonder plek of met een lege tekst', () => {
    const lijst = opties();
    expect(lijst).toHaveLength(18);
    expect(lijst[5]).toEqual({
      id: 5,
      label: '',
      color: 5,
      index: 0,
      isDone: false,
      isDeactivated: false,
      hex: '#c4c4c4',
      description: null,
    });
    expect(lijst[0]?.index).toBeNull();
  });

  it('weigert instellingen zonder labels, of een label zonder kleur', () => {
    expect(() => leesStatusOpties({}, 'x')).toThrow(/geen lijst labels/);
    expect(() => leesStatusOpties({ labels: [{ id: 1, label: 'A' }] }, 'x')).toThrow(/kleur/);
  });
});

describe('ontbrekend', () => {
  /**
   * `FT` staat op de Opportunity als `Feedbacktrainer`, en dat is hetzelfde label. Er een tweede
   * `FT` naast zetten zou ITG twee keuzes voor één merk geven.
   */
  it('telt een schrijfwijze als het label zelf', () => {
    expect(ontbrekend(opties(), BORD)).toEqual([]);
  });

  it('geeft een nieuw label, één keer, zoals het op het bord staat', () => {
    expect(ontbrekend(opties(), [...BORD, ' Nieuw ', 'nieuw'])).toEqual(['Nieuw']);
  });

  /** Een uitgezet label heeft iemand bewust uitgezet; niet onder een nieuw id terugzetten. */
  it('telt een uitgeschakeld label als aanwezig', () => {
    const zonderWj = opties().filter((o) => o.label !== 'WJ');
    expect(ontbrekend(zonderWj, ['WJ'])).toEqual([]);
  });
});

describe('planKeuzelijst', () => {
  it('doet niets als alles er al staat', () => {
    expect(planKeuzelijst(opties(), BORD, 'test')).toEqual({ kind: 'compleet' });
  });

  it('schrijft elk bestaand label ongewijzigd terug, met het nieuwe achteraan', () => {
    const plan = planKeuzelijst(opties(), [...BORD, 'XYZ'], 'test');
    if (plan.kind !== 'toevoegen') {
      throw new Error(`verwacht toevoegen, kreeg ${plan.kind}`);
    }
    expect(plan.namen).toEqual(['XYZ']);
    expect(plan.labels).toHaveLength(19);

    const perId = new Map(plan.labels.filter((l) => l.id !== undefined).map((l) => [l.id, l]));
    for (const oud of opties()) {
      expect(perId.get(oud.id)).toMatchObject({
        label: oud.label,
        color: STATUS_KLEUR[oud.color],
        is_done: oud.isDone,
        is_deactivated: oud.isDeactivated,
      });
    }
    const nieuw = plan.labels[plan.labels.length - 1];
    expect(nieuw).toMatchObject({ label: 'XYZ', index: 18, is_done: false, is_deactivated: false });
    expect(nieuw?.id).toBeUndefined();
  });

  it('houdt de volgorde van de keuzelijst: eerst wie een plek heeft, dan op id', () => {
    const plan = planKeuzelijst(opties(), ['XYZ'], 'test');
    if (plan.kind !== 'toevoegen') {
      throw new Error('verwacht toevoegen');
    }
    expect(plan.labels.slice(0, 4).map((l) => l.label)).toEqual(['', 'SST', 'TMT', 'TT']);
    expect(plan.labels.map((l) => l.index)).toEqual([...Array(19).keys()]);
  });

  /** Elke kleur mag één keer per kolom; het nieuwe label krijgt er een die nog vrij is. */
  it('geeft een nieuw label een kleur die nog niet gebruikt wordt', () => {
    const plan = planKeuzelijst(opties(), ['A', 'B'], 'test');
    if (plan.kind !== 'toevoegen') {
      throw new Error('verwacht toevoegen');
    }
    const kleuren = plan.labels.map((l: StatusLabelInvoer) => l.color);
    expect(new Set(kleuren).size).toBe(kleuren.length);
  });

  it('weigert een kleur die het niet kent, in plaats van hem te raden', () => {
    const vreemd = [...opties(), { ...opties()[0], id: 99, color: 999, label: 'Vreemd' }];
    expect(() => planKeuzelijst(vreemd, ['XYZ'], 'Opportunities')).toThrow(/kleur 999/);
  });

  it('zegt vol als er geen plek meer is', () => {
    const veel = Array.from({ length: MAX_LABELS }, (_, i) => ({
      ...opties()[0],
      id: i,
      color: Number(Object.keys(STATUS_KLEUR)[i]),
      label: `L${i}`,
    }));
    expect(planKeuzelijst(veel, ['XYZ'], 'test')).toEqual({ kind: 'vol', namen: ['XYZ'] });
  });
});

describe('controleerNa', () => {
  it('keurt een lijst waarin alleen het nieuwe label erbij kwam', () => {
    const na = [...opties(), { ...opties()[0], id: 18, color: 0, label: 'XYZ', hex: '#fdab3d' }];
    expect(controleerNa(opties(), na, ['XYZ'])).toEqual([]);
  });

  it('ziet een omgekleurd, verdwenen of hernoemd label', () => {
    const na = opties()
      .filter((o) => o.id !== 3)
      .map((o) => (o.id === 5 ? { ...o, color: 0, hex: '#fdab3d' } : o))
      .map((o) => (o.id === 9 ? { ...o, label: 'IT' } : o));
    const problemen = controleerNa(opties(), na, ['XYZ']).join('\n');
    expect(problemen).toMatch(/label 3 "FV" is verdwenen/);
    expect(problemen).toMatch(/label 5 "": kleur 5 → 0, hex #c4c4c4 → #fdab3d/);
    expect(problemen).toMatch(/label 9 "Incompany Trainer": tekst/);
    expect(problemen).toMatch(/"XYZ" staat er niet in/);
  });
});

describe('syncKeuzelijsten', () => {
  const OPP: KeuzelijstDoel = { boardId: 'o', kolomId: 'label', naam: 'Opportunities' };
  const AGENDA: KeuzelijstDoel = { boardId: 'a', kolomId: 'status23', naam: 'Agenda 2026' };

  function stel(opties_: {
    dryRun?: boolean;
    naSchrijven?: (labels: readonly StatusLabelInvoer[]) => readonly StatusOptie[];
    agendaFout?: boolean;
  }) {
    const geschreven: Array<{
      doel: string;
      revision: string;
      labels: readonly StatusLabelInvoer[];
    }> = [];
    const stand = new Map<string, readonly StatusOptie[]>([
      ['o', opties()],
      ['a', opties()],
    ]);
    const deps: KeuzelijstDeps = {
      dryRun: opties_.dryRun ?? false,
      gewenst: async () => [...BORD, 'Nieuw'],
      doelen: async () => [OPP, AGENDA],
      leesKolom: async (doel) => {
        if (doel.boardId === 'a' && opties_.agendaFout === true) {
          throw new Error('agenda onleesbaar');
        }
        return { revision: `rev-${doel.boardId}`, opties: stand.get(doel.boardId) ?? [] };
      },
      schrijf: async (doel, revision, labels) => {
        geschreven.push({ doel: doel.boardId, revision, labels });
        const na =
          opties_.naSchrijven?.(labels) ??
          labels.map((l, i) => ({
            id: l.id ?? 100 + i,
            label: l.label,
            color: Number(Object.entries(STATUS_KLEUR).find(([, naam]) => naam === l.color)?.[0]),
            index: l.index,
            isDone: l.is_done,
            isDeactivated: l.is_deactivated,
            hex: opties().find((o) => o.id === l.id)?.hex ?? '#000000',
            description: null,
          }));
        stand.set(doel.boardId, na);
      },
    };
    return { deps, geschreven };
  }

  it('voegt het nieuwe label toe op elk bord, met de revisie van het lezen', async () => {
    const { deps, geschreven } = stel({});
    const rapport = await syncKeuzelijsten(deps);
    expect(rapport.doelen.map((d) => d.uitkomst)).toEqual([
      { kind: 'toegevoegd', namen: ['Nieuw'] },
      { kind: 'toegevoegd', namen: ['Nieuw'] },
    ]);
    expect(geschreven.map((g) => [g.doel, g.revision])).toEqual([
      ['o', 'rev-o'],
      ['a', 'rev-a'],
    ]);
    expect(heeftFouten(rapport)).toBe(false);
  });

  it('schrijft niets in een droogloop', async () => {
    const { deps, geschreven } = stel({ dryRun: true });
    const rapport = await syncKeuzelijsten(deps);
    expect(rapport.doelen[0]?.uitkomst).toEqual({ kind: 'zou-toevoegen', namen: ['Nieuw'] });
    expect(geschreven).toEqual([]);
  });

  /** Het hele punt van de controle: Monday deed iets anders dan gevraagd. Hard melden. */
  it('meldt het als Monday een bestaand label anders terugzette', async () => {
    const { deps } = stel({
      naSchrijven: () => opties().map((o) => (o.id === 5 ? { ...o, color: 0 } : o)),
    });
    const rapport = await syncKeuzelijsten(deps);
    const uitkomst = rapport.doelen[0]?.uitkomst;
    expect(uitkomst?.kind).toBe('mislukt');
    expect(uitkomst?.kind === 'mislukt' && uitkomst.fout).toMatch(/klopt de keuzelijst niet meer/);
    expect(heeftFouten(rapport)).toBe(true);
  });

  it('laat een fout op het ene bord het andere niet tegenhouden', async () => {
    const { deps, geschreven } = stel({ agendaFout: true });
    const rapport = await syncKeuzelijsten(deps);
    expect(rapport.doelen.map((d) => d.uitkomst.kind)).toEqual(['toegevoegd', 'mislukt']);
    expect(geschreven.map((g) => g.doel)).toEqual(['o']);
  });
});
