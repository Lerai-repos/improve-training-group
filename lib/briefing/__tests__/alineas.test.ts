import { describe, expect, it } from 'vitest';

import { herstelAlineas, isAchtergrondKop } from '../alineas';

describe('herstelAlineas', () => {
  /**
   * Tekst uit het achtergronddocument is al in alinea's gesplitst en gaat bij het samenstellen
   * nóg een keer door deze functie. Dat mag niets veranderen.
   */
  it('verandert niets aan tekst die al hersteld is', () => {
    const bron =
      'De aanleiding Binnen de winkels.  Over de organisatie  Groot, ongeveer 2  beschikbaar.';
    const eenmaal = herstelAlineas(bron);
    expect(herstelAlineas(eenmaal)).toBe(eenmaal);
  });

  /** Zo levert Monday een enter in een lang tekstveld: twee spaties. */
  it('maakt van twee spaties na een zin een nieuwe alinea', () => {
    expect(herstelAlineas('Eerste alinea.  Tweede alinea.   Derde.')).toBe(
      'Eerste alinea.\nTweede alinea.\nDerde.'
    );
  });

  it('maakt ook van een enter na een kopje een nieuwe alinea', () => {
    expect(herstelAlineas('Aanleiding  Binnen het team')).toBe('Aanleiding\nBinnen het team');
  });

  /** Gemeten: de enige keer twee spaties zonder enter, midden in een zin. */
  it('laat twee spaties vóór een kleine letter staan als één zin', () => {
    expect(herstelAlineas('de ochtend is ongeveer 2  beschikbaar om')).toBe(
      'de ochtend is ongeveer 2  beschikbaar om'
    );
  });

  it('laat echte regeleinden staan en gooit lege regels weg', () => {
    expect(herstelAlineas('Een.\n\n Twee.  Drie.\n')).toBe('Een.\nTwee.\nDrie.');
  });

  /**
   * ITG schrijft de achtergrond met een vaste set kopjes, en Monday plakt die met één spatie
   * aan de zin erna. Gemeten 12-Oct-2026 over 96 teksten: deze acht, telkens aan het begin van
   * een alinea en gevolgd door een hoofdletter. Windgoo had geen enkele andere breuk.
   */
  it('zet de vaste kopjes op een eigen regel, ook met één spatie erachter', () => {
    expect(
      herstelAlineas(
        'Over de organisatie Windgoo is een startup. De aanleiding Binnen de winkels is het goed. ' +
          'De deelnemersgroep Aan de training nemen veertien mensen deel.'
      )
    ).toBe(
      'Over de organisatie\nWindgoo is een startup.\nDe aanleiding\nBinnen de winkels is het goed.\n' +
        'De deelnemersgroep\nAan de training nemen veertien mensen deel.'
    );
  });

  it.each(['Organisatie', 'De organisatie', 'Aanleiding', 'Deelnemers', 'De deelnemers'])(
    'herkent ook het kopje %s',
    (kop) => {
      expect(herstelAlineas(`${kop} Tekst erna.`)).toBe(`${kop}\nTekst erna.`);
    }
  );

  /** Midden in een zin, of met een kleine letter erna, is het geen kopje. */
  it('splitst niet midden in een zin of vóór een kleine letter', () => {
    expect(herstelAlineas('Wij kijken naar de aanleiding Binnen het team.')).toBe(
      'Wij kijken naar de aanleiding Binnen het team.'
    );
    expect(herstelAlineas('Organisatie is belangrijk.')).toBe('Organisatie is belangrijk.');
  });

  it('herkent een kopje dat al op een eigen regel staat', () => {
    expect(isAchtergrondKop('De aanleiding')).toBe(true);
    expect(isAchtergrondKop('De aanleiding Binnen het team')).toBe(false);
  });

  it('laat een ander kopje met één spatie vast aan de zin erna', () => {
    expect(herstelAlineas('Achtergrond Binnen het team')).toBe('Achtergrond Binnen het team');
  });

  it('laat een lege tekst leeg', () => {
    expect(herstelAlineas('   ')).toBe('');
  });
});
