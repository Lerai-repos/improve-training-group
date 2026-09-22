import { describe, expect, it } from 'vitest';

import { ankerItemId, bepaalCyclusKeuze, regelVoorstel, type CyclusKandidaat } from '../cyclus';
import { metBevestiging, type BevestigdeCycli } from '../cyclus-bevestiging';

/** Het anker in deze tests: de laagste id, zoals de kandidaten hier ook op datum staan. */
const ANKER = (leden: readonly string[]): string =>
  [...leden].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];

/**
 * Welke sessies samen één trainingscyclus zijn.
 *
 * Twee lagen, en het verschil is het hele punt: de REGEL stelt voor (dezelfde Opportunity,
 * cycluslabel, klanttitel, thema's en trainers), en de ADVISEUR bevestigt. Zonder bevestiging
 * houdt elke sessie haar eigen briefing.
 */

const sessie = (over: Partial<CyclusKandidaat> & { itemId: string }): CyclusKandidaat => ({
  boardId: '5087396949',
  gearchiveerd: false,
  isCyclus: true,
  klanttitel: 'Navigating difficult conversations',
  themaIds: ['t1'],
  leadIds: ['lead'],
  coIds: ['co'],
  trainerNamen: 'Isabelle Zwetsloot',
  duur: '',
  ieCode: '',
  datum: '2026-09-22',
  tijden: '09:00 - 13:00',
  locatie: 'Breskensweg 5, Almere',
  groepsgrootte: '50',
  ...over,
});

const voorgesteld = (itemId: string, kandidaten: readonly CyclusKandidaat[]): string[] =>
  [...regelVoorstel(itemId, kandidaten).leden].sort();

describe('regelVoorstel', () => {
  it('stelt sessies voor met dezelfde klanttitel, thema en trainers', () => {
    const kandidaten = [
      sessie({ itemId: '1', datum: '2026-09-22' }),
      sessie({ itemId: '2', datum: '2027-01-04' }),
    ];
    expect(voorgesteld('2', kandidaten)).toEqual(['1', '2']);
  });

  it('stelt niets voor als deze training geen trainingscyclus is', () => {
    const kandidaten = [sessie({ itemId: '1', isCyclus: false }), sessie({ itemId: '2' })];
    expect(voorgesteld('1', kandidaten)).toEqual(['1']);
  });

  it('stelt nooit een sessie zonder trainer voor, en stelt er zelf ook geen voor', () => {
    const kandidaten = [sessie({ itemId: '1' }), sessie({ itemId: '2', leadIds: [], coIds: [] })];
    expect(voorgesteld('1', kandidaten)).toEqual(['1']);
    expect(regelVoorstel('1', kandidaten).redenen.get('2')).toBe('geen trainer');
    expect(voorgesteld('2', [sessie({ itemId: '2', leadIds: [], coIds: [] })])).toEqual(['2']);
  });

  it('negeert hoofdletters en spaties in de klanttitel', () => {
    expect(
      voorgesteld('1', [
        sessie({ itemId: '1' }),
        sessie({ itemId: '2', klanttitel: ' navigating  Difficult conversations ' }),
      ])
    ).toEqual(['1', '2']);
  });

  /** International School Almere: `… I` en `… II` zijn samen één cyclus. */
  it('negeert een volgnummer aan het eind van de klanttitel', () => {
    expect(
      voorgesteld('1', [
        sessie({ itemId: '1', klanttitel: 'Navigating difficult conversations I' }),
        sessie({ itemId: '2', klanttitel: 'Navigating difficult conversations II' }),
        sessie({ itemId: '3', klanttitel: 'Navigating difficult conversations 3' }),
      ])
    ).toEqual(['1', '2', '3']);
  });

  it('geeft per afgewezen sessie een reden', () => {
    const { leden, redenen } = regelVoorstel('1', [
      sessie({ itemId: '1' }),
      sessie({ itemId: '2', klanttitel: 'Iets anders' }),
      sessie({ itemId: '3', coIds: ['ander'] }),
      sessie({ itemId: '4', themaIds: ['t9'] }),
      sessie({ itemId: '5', isCyclus: false }),
    ]);
    expect([...leden]).toEqual(['1']);
    expect(redenen.get('2')).toBe('een andere klanttitel ("Iets anders")');
    expect(redenen.get('3')).toBe('andere trainers');
    expect(redenen.get('4')).toBe("andere thema's");
    /** Zonder cycluslabel is het geen sessie van een cyclus; daar is niets over te zeggen. */
    expect(redenen.has('5')).toBe(false);
  });

  it('telt de koppelvolgorde van de trainers niet mee', () => {
    expect(
      voorgesteld('1', [
        sessie({ itemId: '1', coIds: ['a', 'b'] }),
        sessie({ itemId: '2', coIds: ['b', 'a'] }),
      ])
    ).toEqual(['1', '2']);
  });

  describe("thema's", () => {
    it('stelt een sessie zonder thema wél voor', () => {
      expect(
        voorgesteld('2', [
          sessie({ itemId: '1', datum: '2026-10-08' }),
          sessie({ itemId: '2', datum: '2026-10-29', themaIds: [] }),
        ])
      ).toEqual(['1', '2']);
    });

    /**
     * Twee verschillende ingevulde sets: bij welke hoort de sessie zonder thema? Niet raden —
     * de adviseur kan hem zelf aanvinken.
     */
    it('stelt een sessie zonder thema niet voor als er twee themasets zijn', () => {
      const kandidaten = [
        sessie({ itemId: 'x', themaIds: ['t1'] }),
        sessie({ itemId: 'leeg', themaIds: [] }),
        sessie({ itemId: 'y', themaIds: ['t2'] }),
      ];
      expect(voorgesteld('x', kandidaten)).toEqual(['x']);
      expect(regelVoorstel('x', kandidaten).redenen.get('leeg')).toBe(
        "geen thema, en de cyclus heeft verschillende thema's"
      );
    });
  });

  it('werpt als de training zelf niet tussen de kandidaten zit', () => {
    expect(() => regelVoorstel('9', [sessie({ itemId: '1' })])).toThrow(/9/);
  });
});

describe('bepaalCyclusKeuze', () => {
  const twee = [
    sessie({ itemId: '1', datum: '2026-09-22' }),
    sessie({ itemId: '2', datum: '2027-01-04' }),
  ];

  it('vraagt om bevestiging en bundelt nog niets', () => {
    const { cyclus, keuze } = bepaalCyclusKeuze('1', twee, null);
    expect(cyclus).toBeNull();
    expect(keuze?.openstaand).toBe(true);
    expect(keuze?.opties.map((o) => [o.itemId, o.huidig, o.aangevinkt, o.voorgesteld])).toEqual([
      ['1', true, true, true],
      ['2', false, true, true],
    ]);
  });

  /** Onder een Opportunity hangt soms een lege rij; die valt nooit te briefen. */
  it('laat een sessie zonder datum én zonder trainer helemaal weg', () => {
    const { keuze } = bepaalCyclusKeuze(
      '1',
      [...twee, sessie({ itemId: 'leeg', datum: '', leadIds: [], coIds: [] })],
      null
    );
    expect(keuze?.opties.map((o) => o.itemId)).toEqual(['1', '2']);
  });

  it('zet de sessies op datum, deze training ertussen', () => {
    const { keuze } = bepaalCyclusKeuze(
      '2',
      [...twee, sessie({ itemId: '0', datum: '2026-06-01', klanttitel: 'Iets anders' })],
      null
    );
    expect(keuze?.opties.map((o) => [o.itemId, o.huidig])).toEqual([
      ['0', false],
      ['1', false],
      ['2', true],
    ]);
  });

  it('vraagt niets als er geen andere sessies onder de opdracht staan', () => {
    expect(bepaalCyclusKeuze('1', [sessie({ itemId: '1' })], null)).toEqual({
      cyclus: null,
      keuze: null,
    });
  });

  it('bundelt pas na bevestiging, oudste sessie eerst', () => {
    const bevestigd: BevestigdeCycli = {
      groepen: [{ leden: ['2', '1'], anker: '1' }],
      beslist: { '1': ['1', '2'], '2': ['1', '2'] },
      verhuizingen: [],
    };
    const { cyclus, keuze } = bepaalCyclusKeuze('2', twee, bevestigd);
    expect(cyclus?.sessies.map((s) => s.itemId)).toEqual(['1', '2']);
    expect(keuze?.openstaand).toBe(false);
  });

  /** "Nee, dit is geen cyclus" is ook een antwoord: de vraag hoort dan niet terug te komen. */
  it('onthoudt een bevestiging zonder groep', () => {
    const { cyclus, keuze } = bepaalCyclusKeuze('1', twee, {
      groepen: [],
      beslist: { '1': ['1', '2'] },
      verhuizingen: [],
    });
    expect(cyclus).toBeNull();
    expect(keuze?.openstaand).toBe(false);
    expect(keuze?.opties.map((o) => o.aangevinkt)).toEqual([true, false]);
  });

  it('stelt de vraag opnieuw zodra er een sessie bij komt', () => {
    const derde = [...twee, sessie({ itemId: '3', datum: '2027-03-01' })];
    const { cyclus, keuze } = bepaalCyclusKeuze('1', derde, {
      groepen: [{ leden: ['1', '2'], anker: '1' }],
      beslist: { '1': ['1', '2'], '2': ['1', '2'] },
      verhuizingen: [],
    });
    expect(cyclus?.sessies.map((s) => s.itemId)).toEqual(['1', '2']);
    expect(keuze?.openstaand).toBe(true);
    expect(keuze?.opties.map((o) => [o.itemId, o.aangevinkt])).toEqual([
      ['1', true],
      ['2', true],
      ['3', false],
    ]);
  });

  /**
   * Twee cycli onder één opdracht (Reinaerde). Bevestigen vanaf de ene mag de andere niet
   * stilzwijgend als "geen cyclus" afdoen — die vraag is daar nooit gesteld.
   */
  it('laat de vraag openstaan voor een sessie die niet mee bevestigd is', () => {
    const kandidaten = [
      sessie({ itemId: 'a', datum: '2026-06-18' }),
      sessie({ itemId: 'b', datum: '2026-07-14' }),
      sessie({ itemId: 'c', datum: '2026-10-08', klanttitel: 'Intervisie' }),
      sessie({ itemId: 'd', datum: '2026-10-29', klanttitel: 'Intervisie' }),
    ];
    const na = metBevestiging(null, 'c', ['c', 'd'], ['a', 'b', 'c', 'd'], ANKER);
    expect(bepaalCyclusKeuze('c', kandidaten, na).keuze?.openstaand).toBe(false);
    expect(bepaalCyclusKeuze('a', kandidaten, na).keuze?.openstaand).toBe(true);
  });

  /** De adviseur mag de regel overrulen; wat hij aanvinkt telt, niet wat wij vonden. */
  it('volgt een bevestiging die van de regel afwijkt', () => {
    const kandidaten = [
      sessie({ itemId: '1', datum: '2026-09-22' }),
      sessie({ itemId: '2', datum: '2027-01-04', klanttitel: 'Heel iets anders' }),
    ];
    const { cyclus, keuze } = bepaalCyclusKeuze('1', kandidaten, {
      groepen: [{ leden: ['1', '2'], anker: '1' }],
      beslist: { '1': ['1', '2'], '2': ['1', '2'] },
      verhuizingen: [],
    });
    expect(cyclus?.sessies.map((s) => s.itemId)).toEqual(['1', '2']);
    expect(keuze?.opties[1]).toMatchObject({
      aangevinkt: true,
      voorgesteld: false,
      reden: 'een andere klanttitel ("Heel iets anders")',
    });
  });
});

describe('metBevestiging', () => {
  it('legt de aangevinkte sessies vast als groep', () => {
    expect(metBevestiging(null, '1', ['1', '2'], ['1', '2'], ANKER)).toEqual({
      groepen: [{ leden: ['1', '2'], anker: '1' }],
      beslist: { '1': ['1', '2'], '2': ['1', '2'] },
      verhuizingen: [],
    });
  });

  it('legt "geen cyclus" vast als een beantwoorde vraag zonder groep', () => {
    expect(metBevestiging(null, '1', ['1'], ['1', '2'], ANKER)).toEqual({
      groepen: [],
      /** Alleen deze sessie is beoordeeld; over sessie 2 is niets gezegd. */
      beslist: { '1': ['1', '2'] },
      verhuizingen: [],
    });
  });

  it('vervangt de groep waar deze training in zat', () => {
    const huidig: BevestigdeCycli = {
      groepen: [{ leden: ['1', '2', '3'], anker: '1' }],
      beslist: { '1': ['1', '2', '3'], '2': ['1', '2', '3'], '3': ['1', '2', '3'] },
      verhuizingen: [],
    };
    expect(metBevestiging(huidig, '1', ['1', '2'], ['1', '2', '3'], ANKER).groepen).toEqual([
      { leden: ['1', '2'], anker: '1' },
    ]);
  });

  /** Onder één opdracht kunnen twee cycli staan; bevestigen vanaf de ene raakt de andere niet. */
  it('laat een andere groep staan, maar haalt er een aangevinkte sessie uit', () => {
    const huidig: BevestigdeCycli = {
      groepen: [
        { leden: ['a', 'b'], anker: 'a' },
        { leden: ['c', 'd', 'e'], anker: 'c' },
      ],
      beslist: {},
      verhuizingen: [],
    };
    expect(
      metBevestiging(huidig, 'a', ['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e'], ANKER).groepen
    ).toEqual([
      { leden: ['d', 'e'], anker: 'd' },
      { leden: ['a', 'b', 'c'], anker: 'a' },
    ]);
  });

  /**
   * `d` blijft zonder groep achter doordat `c` bij een andere cyclus wordt gevinkt. Over `d`
   * heeft niemand iets gezegd, dus zijn vraag hoort weer open te staan.
   */
  it('laat de beslissing vervallen van een sessie die uit haar groep valt', () => {
    const huidig: BevestigdeCycli = {
      groepen: [{ leden: ['c', 'd'], anker: 'c' }],
      beslist: { c: ['a', 'c', 'd'], d: ['a', 'c', 'd'] },
      verhuizingen: [],
    };
    const na = metBevestiging(huidig, 'a', ['a', 'c'], ['a', 'c', 'd'], ANKER);
    expect(na.groepen).toEqual([{ leden: ['a', 'c'], anker: 'a' }]);
    expect(na.beslist.d).toBeUndefined();
    expect(Object.keys(na.beslist).sort()).toEqual(['a', 'c']);
  });

  it('laat een groep vervallen die op één sessie overblijft', () => {
    const huidig: BevestigdeCycli = {
      groepen: [{ leden: ['c', 'd'], anker: 'c' }],
      beslist: { c: ['c', 'd'], d: ['c', 'd'] },
      verhuizingen: [],
    };
    expect(metBevestiging(huidig, 'a', ['a', 'c'], ['a', 'c', 'd'], ANKER).groepen).toEqual([
      { leden: ['a', 'c'], anker: 'a' },
    ]);
  });
});

describe('ankerItemId', () => {
  /**
   * Een cyclus mag over de jaarwisseling lopen, maar de checklist-route weigert een
   * gearchiveerd bord — het anker moet dus te schrijven blijven.
   */
  it('slaat een sessie op een gearchiveerd bord over', () => {
    const kandidaten = [
      sessie({ itemId: 'oud', datum: '2025-12-01', gearchiveerd: true }),
      sessie({ itemId: 'nieuw', datum: '2026-01-10' }),
    ];
    const cyclus = bepaalCyclusKeuze('nieuw', kandidaten, {
      groepen: [{ leden: ['oud', 'nieuw'], anker: 'nieuw' }],
      beslist: { oud: ['oud', 'nieuw'], nieuw: ['oud', 'nieuw'] },
      verhuizingen: [],
    }).cyclus;
    expect(cyclus?.sessies.map((s) => s.itemId)).toEqual(['oud', 'nieuw']);
    expect(ankerItemId({ itemId: 'nieuw', cyclus })).toBe('nieuw');
  });

  it('is de eerste sessie van de bevestigde cyclus, of anders de training zelf', () => {
    expect(ankerItemId({ itemId: '2', cyclus: null })).toBe('2');
    expect(
      ankerItemId({
        itemId: '2',
        cyclus: bepaalCyclusKeuze(
          '2',
          [
            sessie({ itemId: '1', datum: '2026-09-22' }),
            sessie({ itemId: '2', datum: '2027-01-04' }),
          ],
          {
            groepen: [{ leden: ['1', '2'], anker: '1' }],
            beslist: { '1': ['1', '2'], '2': ['1', '2'] },
            verhuizingen: [],
          }
        ).cyclus,
      })
    ).toBe('1');
  });
});
