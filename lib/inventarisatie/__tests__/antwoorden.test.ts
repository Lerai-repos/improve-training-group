import { describe, expect, it } from 'vitest';

import { antwoordenVoor } from '../antwoorden';

/** De kop zoals hij in de sheet staat, met de onzichtbare tekens die Google Forms meegeeft. */
const KOP = [
  'Tijdstempel',
  'Wat is je naam?',
  '\u2060\u2060Voor welke organisatie werk je?',
  'Hoe staan de deelnemers tegenover de sessie?  ',
  'Ter verificatie: wat is het exacte adres waar de sessie plaats zal vinden?',
  'Referentie (niet aanpassen)',
];

describe('antwoordenVoor', () => {
  it('geeft de vragen met antwoord van de Opportunity, opgeschoond', () => {
    const uit = antwoordenVoor(
      [KOP, ['13-10-2026 10:41:23', 'Paula', 'Probiblio', 'Open', 'Dorpsstraat 1', '42']],
      '42'
    );
    expect(uit).toEqual({
      kind: 'ingevuld',
      op: '13-10-2026 10:41:23',
      antwoorden: [
        { vraag: 'Wat is je naam?', antwoord: 'Paula' },
        { vraag: 'Voor welke organisatie werk je?', antwoord: 'Probiblio' },
        { vraag: 'Hoe staan de deelnemers tegenover de sessie?', antwoord: 'Open' },
        {
          vraag: 'Ter verificatie: wat is het exacte adres waar de sessie plaats zal vinden?',
          antwoord: 'Dorpsstraat 1',
        },
      ],
    });
  });

  /** Vult de klant het twee keer in, dan telt de laatste: de sheet loopt op volgorde van binnenkomst. */
  it('neemt de nieuwste inzending als de klant hem vaker invulde', () => {
    const uit = antwoordenVoor(
      [
        KOP,
        ['13-10-2026 10:00:00', 'Paula', 'Oud', '', '', '42'],
        ['13-10-2026 11:00:00', 'Anna', 'Ander', '', '', '7'],
        ['13-10-2026 12:00:00', 'Paula', 'Nieuw', '', '', ' 42 '],
      ],
      '42'
    );
    expect(uit).toMatchObject({ kind: 'ingevuld', op: '13-10-2026 12:00:00' });
    expect(uit.kind === 'ingevuld' && uit.antwoorden[1]).toEqual({
      vraag: 'Voor welke organisatie werk je?',
      antwoord: 'Nieuw',
    });
  });

  it('laat lege antwoorden weg', () => {
    const uit = antwoordenVoor([KOP, ['t', 'Paula', '', '  ', '', '42']], '42');
    expect(uit.kind === 'ingevuld' && uit.antwoorden).toEqual([
      { vraag: 'Wat is je naam?', antwoord: 'Paula' },
    ]);
  });

  it('is leeg als de Opportunity er niet in staat', () => {
    expect(antwoordenVoor([KOP, ['t', 'Anna', 'X', '', '', '7']], '42')).toEqual({
      kind: 'leeg',
    });
    expect(antwoordenVoor([KOP], '42')).toEqual({ kind: 'leeg' });
  });

  /** Zonder die kolom is niets aan een Opportunity te koppelen; "leeg" zou dan liegen. */
  it('weigert een sheet zonder Referentie-kolom', () => {
    expect(() => antwoordenVoor([['Tijdstempel', 'Wat is je naam?']], '42')).toThrow(
      /Referentie/
    );
  });

  it('weigert een sheet zonder kop', () => {
    expect(() => antwoordenVoor([], '42')).toThrow(/kop/);
  });
});
