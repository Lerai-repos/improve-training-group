import { describe, expect, it } from 'vitest';

import {
  formatTrainingCode,
  isProductCode,
  resolveCodes,
  type CodesByName,
  type ThemaKaart,
} from '../mc-codes';

/**
 * De opzoektabel voor de Monday Challenge-codes.
 *
 * De nadruk ligt op de twee manieren waarop dit stil fout gaat: een cel die twee codes
 * krijgt aangeboden, en een naam die op het verkeerde thema landt.
 */

const bord = new Set(['Veranderen', 'Persoonlijk leiderschap/Je ideale ik', 'Feedback']);

const kaart: ThemaKaart = {
  kaart: {
    'Succesvol veranderen': 'Veranderen',
    'Gewoontes en patronen veranderen': 'Veranderen',
    'Je ideale ik': 'Persoonlijk leiderschap/Je ideale ik',
    'Persoonlijk leiderschap': 'Persoonlijk leiderschap/Je ideale ik',
  },
  openVraag: { 'Verjaag de Calimero in je': 'Geen duidelijke tegenhanger.' },
};

const codes = (rows: Record<string, Record<string, string>>): CodesByName =>
  new Map(
    Object.entries(rows).map(([naam, perLabel]) => [naam, new Map(Object.entries(perLabel))])
  );

describe('resolveCodes', () => {
  /**
   * Twee namen op één thema is GEEN probleem zolang ze andere labelkolommen vullen. Dat is
   * de normale stand: ITG verkoopt hetzelfde thema onder meerdere merken met een eigen code.
   */
  it('zet twee namen naast elkaar in dezelfde themaregel', () => {
    const uit = resolveCodes(
      codes({
        'Succesvol veranderen': { IT: 'IT-51', JE: 'JE-53' },
        'Gewoontes en patronen veranderen': { FV: 'FV-11', WJ: 'WJ-11' },
      }),
      kaart,
      bord
    );

    expect(uit.botsingen).toEqual([]);
    expect([...(uit.perThema.get('Veranderen') ?? [])]).toEqual([
      ['IT', 'IT-51'],
      ['JE', 'JE-53'],
      ['FV', 'FV-11'],
      ['WJ', 'WJ-11'],
    ]);
  });

  /**
   * Botsen ze wél op één label, dan blijft die cel LEEG. De ene code is net zo plausibel als
   * de andere, en een verkeerde staat straks in een document bij de klant zonder dat er iets
   * faalt. De rest van de rij gaat gewoon door.
   */
  it('laat een botsende cel leeg en schrijft de rest wel', () => {
    const uit = resolveCodes(
      codes({
        'Je ideale ik': { IT: 'IT-22', FV: 'FV-31' },
        'Persoonlijk leiderschap': { IT: 'IT-39' },
      }),
      kaart,
      bord
    );

    expect(uit.botsingen).toHaveLength(1);
    expect(uit.botsingen[0]).toMatchObject({
      thema: 'Persoonlijk leiderschap/Je ideale ik',
      label: 'IT',
    });
    const rij = uit.perThema.get('Persoonlijk leiderschap/Je ideale ik');
    expect(rij?.has('IT')).toBe(false);
    // FV botst niet en gaat er gewoon in.
    expect(rij?.get('FV')).toBe('FV-31');
  });

  /** Dezelfde code twee keer aangeboden is geen botsing; er valt niets te kiezen. */
  it('ziet dezelfde code van twee namen niet als botsing', () => {
    const uit = resolveCodes(
      codes({
        'Succesvol veranderen': { TT: 'TT-21' },
        'Gewoontes en patronen veranderen': { TT: 'TT-21' },
      }),
      kaart,
      bord
    );

    expect(uit.botsingen).toEqual([]);
    expect(uit.perThema.get('Veranderen')?.get('TT')).toBe('TT-21');
  });

  /**
   * Een naam in `openVraag` verdwijnt UIT de berekening, en dat is precies de val.
   *
   * Zolang `Verjaag de Calimero in je` als openstaande vraag stond, leverde `Zichtbaarheid
   * en invloed vergroten` JE-69 onbetwist aan en werd die weggeschreven: de keuze die
   * niemand had gemaakt, stond al op het bord. Wie een cel open wil houden, hoort de naam
   * in `kaart` te zetten en de botsingsdetectie zijn werk te laten doen.
   */
  it('houdt een cel NIET open via openVraag; dat doet de botsingsdetectie', () => {
    const viaOpenVraag = resolveCodes(
      codes({ 'Verjaag de Calimero in je': { JE: 'JE-62' }, Feedback: { JE: 'JE-69' } }),
      { kaart: kaart.kaart, openVraag: { 'Verjaag de Calimero in je': 'onbekend' } },
      bord
    );
    // De concurrent vult de cel gewoon: openVraag beschermt hem niet.
    expect(viaOpenVraag.perThema.get('Feedback')?.get('JE')).toBe('JE-69');
    expect(viaOpenVraag.botsingen).toEqual([]);

    const viaKaart = resolveCodes(
      codes({ 'Verjaag de Calimero in je': { JE: 'JE-62' }, Feedback: { JE: 'JE-69' } }),
      { kaart: { ...kaart.kaart, 'Verjaag de Calimero in je': 'Feedback' }, openVraag: {} },
      bord
    );
    // Nu botsen ze en blijft de cel leeg. `undefined` mag ook: botst het ENIGE label van
    // een thema, dan ontstaat er voor dat thema helemaal geen rij.
    expect(viaKaart.perThema.get('Feedback')?.get('JE')).toBeUndefined();
    expect(viaKaart.botsingen).toHaveLength(1);
  });

  it('schrijft niets weg voor een openstaande vraag', () => {
    const uit = resolveCodes(codes({ 'Verjaag de Calimero in je': { JE: 'JE-62' } }), kaart, bord);

    expect(uit.perThema.size).toBe(0);
    expect(uit.ongekoppeld).toContain('Verjaag de Calimero in je');
  });

  /**
   * Nooit normaliseren. Een naam die niet letterlijk gelijk is en niet in de kaart staat,
   * blijft ongekoppeld — ook als hij er sprekend op lijkt.
   */
  it('koppelt niet op gelijkenis', () => {
    const uit = resolveCodes(codes({ Feedbck: { IT: 'IT-1' } }), kaart, bord);

    expect(uit.perThema.size).toBe(0);
    expect(uit.ongekoppeld).toEqual(['Feedbck']);
  });

  /**
   * ITG's werkblad heeft NOTITIES in de codekolom staan: `NOG MAKEN` bij een challenge die
   * nog niet bestaat. Die tekst wegschrijven zet "NOG MAKEN" in de gegevenstabel van een
   * briefing bij de klant, zonder dat er iets faalt.
   */
  it('schrijft een notitie in de codekolom niet weg als code', () => {
    const uit = resolveCodes(codes({ Feedback: { IT: 'NOG MAKEN', JE: 'JE-14' } }), kaart, bord);

    expect(uit.perThema.get('Feedback')?.has('IT')).toBe(false);
    expect(uit.geenCode).toEqual([
      { thema: 'Feedback', label: 'IT', waarde: 'NOG MAKEN', via: 'Feedback' },
    ]);
    // De rest van de rij gaat gewoon door.
    expect(uit.perThema.get('Feedback')?.get('JE')).toBe('JE-14');
  });

  it('herkent de vormen die ITG echt gebruikt', () => {
    expect(['IT-58', 'SST-9', 'TMT-1', 'CP-24'].every(isProductCode)).toBe(true);
    expect(['NOG MAKEN', '', 'IT58', 'IT-', '-1', 'it-58'].some(isProductCode)).toBe(false);
  });

  it('koppelt een letterlijk gelijke naam zonder kaart', () => {
    const uit = resolveCodes(codes({ Feedback: { IT: 'IT-13' } }), kaart, bord);

    expect(uit.perThema.get('Feedback')?.get('IT')).toBe('IT-13');
  });
});

describe('formatTrainingCode', () => {
  it('schrijft één code gewoon uit', () => {
    expect(formatTrainingCode(['IT-58'], 'NL')).toBe('IT-58');
  });

  /**
   * Een training kan aan meer dan één thema hangen en de gegevenstabel heeft één regel.
   * Er stil eentje laten vallen geeft de trainer een code voor de helft van zijn sessie.
   */
  it('plakt meerdere thema’s aaneen met &', () => {
    expect(formatTrainingCode(['IT-58', 'IT-12'], 'NL')).toBe('IT-58 & IT-12');
  });

  /** ITG's eigen notitie bovenaan het werkblad: "ZET -ENG achter code". Per code. */
  it('hangt -ENG achter elke code bij een Engelstalige training', () => {
    expect(formatTrainingCode(['IT-58', 'IT-12'], 'ENG')).toBe('IT-58-ENG & IT-12-ENG');
  });

  /**
   * Tweetalig krijgt ze allebei. Dirkje, 27-Aug-2026: *"als we het toch perfect kunnen
   * opzetten dan zou ik in dit geval beide doen met een / ertussen."* Negen trainingen.
   */
  it('geeft bij NL + ENG beide codes, gescheiden door /', () => {
    expect(formatTrainingCode(['IT-58'], 'NL + ENG')).toBe('IT-58 / IT-58-ENG');
  });

  /** Vrije tekst, dus op inhoud toetsen en niet op één exacte spelling. */
  it('herkent de tweetalige vorm ook andersom geschreven', () => {
    expect(formatTrainingCode(['IT-58'], 'ENG + NL')).toBe('IT-58 / IT-58-ENG');
    expect(formatTrainingCode(['IT-58'], 'Nederlands / Engels')).toBe('IT-58 / IT-58-ENG');
  });

  it('laat een lege of onbekende taal met rust', () => {
    expect(formatTrainingCode(['IT-58'], '')).toBe('IT-58');
    expect(formatTrainingCode(['IT-58'], 'NL')).toBe('IT-58');
  });

  /**
   * Twee scheidingstekens met verschillende betekenis: ` & ` tussen thema's, ` / ` tussen de
   * taalvarianten van één thema. Bij een tweetalige training met twee thema's staan ze dus
   * allebei in dezelfde regel.
   */
  it('houdt de twee scheidingstekens uit elkaar', () => {
    expect(formatTrainingCode(['IT-58', 'IT-12'], 'NL + ENG')).toBe(
      'IT-58 / IT-58-ENG & IT-12 / IT-12-ENG'
    );
  });

  /**
   * Een thema zonder challenge levert een LEGE regel, geen melding. Dat is een
   * eindtoestand voor 19 van de 100 thema's, geen ontbrekende koppeling.
   */
  it('laat thema’s zonder code weg in plaats van een gat te maken', () => {
    expect(formatTrainingCode(['IT-58', ''], 'NL')).toBe('IT-58');
    expect(formatTrainingCode(['', ''], 'NL')).toBe('');
    expect(formatTrainingCode([], 'ENG')).toBe('');
  });
});
