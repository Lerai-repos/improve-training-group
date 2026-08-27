import { describe, expect, it } from 'vitest';

import { conflictText, dayConflictLabel } from '../format';

/**
 * De regel onder de trainersnaam.
 *
 * Vorm besloten door Tim (24-Aug-2026): *"just a label, or greyed out that they are
 * planned in"* — dus tonen, niet filteren en niet anders sorteren. De tekst zegt wát er
 * die dag staat en trekt geen conclusie, want `Tijden` is vrije tekst en twee sessies op
 * één dag is bij ITG legitiem.
 *
 * **De klantnaam bereikt deze functie in productie niet meer.** ITG wilde hem van de regel
 * af (27-Aug-2026) en `resolveWorkload` haalt hem er nu voor iedereen uit. Deze functie
 * blijft algemeen — hij laat weg wat er niet is — zodat het terugzetten één regel is en
 * niet een nieuwe opmaakregel. De klant-gevallen hieronder toetsen dus de functie, niet
 * de vorm die de planner ziet.
 */

describe('dayConflictLabel', () => {
  /** Wat de planner werkelijk ziet sinds 27-Aug-2026: het tijdstip, zonder klantnaam. */
  it('noemt het tijdstip', () => {
    expect(dayConflictLabel([{ client: null, times: '09:30-12:30' }])).toBe(
      'Al ingepland — 09:30-12:30'
    );
  });

  it('voegt klant en tijd samen als er wél een klant is', () => {
    expect(dayConflictLabel([{ client: 'Probiblio', times: '09:30-12:30' }])).toBe(
      'Al ingepland — Probiblio, 09:30-12:30'
    );
  });

  /** Niets is de normale stand; die rijen krijgen geen regel. */
  it('geeft null als er niets is', () => {
    expect(dayConflictLabel([])).toBeNull();
  });

  it('laat weg wat er niet is', () => {
    expect(dayConflictLabel([{ client: 'Probiblio', times: null }])).toBe(
      'Al ingepland — Probiblio'
    );
    expect(dayConflictLabel([{ client: null, times: '09:30-12:30' }])).toBe(
      'Al ingepland — 09:30-12:30'
    );
  });

  /**
   * Bekend dat er iets staat, onbekend wát — bijvoorbeeld als beide kolommen hernoemd
   * zijn. Nog steeds het melden waard: de planner kan zelf kijken.
   */
  it('meldt het ook zonder klant én zonder tijd', () => {
    expect(dayConflictLabel([{ client: null, times: null }])).toBe('Al ingepland');
  });

  /**
   * De tabel is vijftien kolommen breed. Alles uitschrijven zou de regel laten aflopen;
   * de volledige lijst staat in de tooltip.
   */
  it('kapt af en telt de rest', () => {
    const drie = [
      { client: 'A', times: '09:00-10:00' },
      { client: 'B', times: '11:00-12:00' },
      { client: 'C', times: '13:00-14:00' },
    ];

    expect(dayConflictLabel(drie)).toBe('Al ingepland — A, 09:00-10:00 · B, 11:00-12:00 +1');
  });

  it('zet één botsing samen tot klant en tijd', () => {
    expect(conflictText({ client: 'Calduran', times: '13:00-16:00' })).toBe(
      'Calduran, 13:00-16:00'
    );
    expect(conflictText({ client: null, times: null })).toBe('');
  });
});
