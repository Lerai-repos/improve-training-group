import { describe, expect, it } from 'vitest';

import {
  formatDateTime,
  formatDuration,
  formatEvaluation,
  formatGroupSize,
  formatIeCode,
  formatClientContact,
  formatTravel,
  formatLanguage,
} from '../format';

/**
 * De zestien rijen van `2.0 ITG vb Briefing Probiblio …docx` naast de waarden die het
 * agendabord voor diezelfde training (item 2620142638) teruggeeft. Dit is het enige
 * uitgewerkte voorbeeld dat er is, dus als een van deze verwachtingen verandert, is de
 * afspraak veranderd en niet de code.
 */
describe('de gegevenstabel van de voorbeeldbriefing', () => {
  it('reproduceert de rijen die uit één kolom komen', () => {
    expect(formatDuration('3')).toBe('3 uur');
    expect(formatDateTime('2026-03-24', '09:30-12:30')).toBe('24 maart 2026; 09:30 - 12:30 uur');
    expect(formatGroupSize('10-20')).toBe('± 10-20 deelnemers');
    expect(formatLanguage('NL')).toBe('Nederlands');
    expect(formatClientContact('Telefoon')).toBe('Telefonisch contact');
    expect(formatEvaluation('Geen QR (deze sessie)')).toBe('Nee');
    expect(formatIeCode('')).toBe('Geen');
  });
});

describe('formatDuration', () => {
  /**
   * De kolom `Duur` heeft 61 verschillende waarden. Zomaar ` uur` erachter plakken levert
   * `2x 1 uur uur` en `3 x 45 min uur` op, en dat zijn geen randgevallen: samengestelde
   * duren zijn een flink deel van de staart.
   */
  it('laat alles staan wat de eenheid al zelf schrijft', () => {
    for (const raw of ['2,5 uur', '2x 1 uur', '1,5 uur x 4', '3 x 45 min', '2 - 2,5 uur', '2 x 4 uur']) {
      expect(formatDuration(raw)).toBe(raw);
    }
  });

  it('vult alleen een kale opgave aan', () => {
    expect(formatDuration('4')).toBe('4 uur');
    expect(formatDuration('3,5')).toBe('3,5 uur');
    expect(formatDuration('')).toBe('');
  });
});

describe('formatDateTime', () => {
  it('normaliseert de tijden die het bord echt bevat', () => {
    expect(formatDateTime('2026-03-24', '9:30-12:30')).toBe('24 maart 2026; 09:30 - 12:30 uur');
    expect(formatDateTime('2026-03-24', '09.30 - 12.30')).toBe('24 maart 2026; 09:30 - 12:30 uur');
  });

  /** Vrije tekst blijft vrije tekst; er wordt geen tijd bij verzonnen. */
  it('geeft onherkenbare tijden onveranderd door', () => {
    expect(formatDateTime('2026-03-24', 'in overleg')).toBe('24 maart 2026; in overleg');
    expect(formatDateTime('2026-03-24', '')).toBe('24 maart 2026');
  });

  it('levert niets zonder bruikbare datum', () => {
    expect(formatDateTime('', '09:30 - 12:30')).toBe('');
    expect(formatDateTime('24-03-2026', '09:30 - 12:30')).toBe('');
  });
});

describe('formatGroupSize', () => {
  /**
   * 215 verschillende waarden over 823 trainingen. `± max 15 deelnemers` is onzin, en
   * `3 groepen à 10 deelnemers deelnemers` ook.
   */
  it('zet ± alleen voor een kaal aantal', () => {
    expect(formatGroupSize('15')).toBe('± 15 deelnemers');
    expect(formatGroupSize('20 - 25')).toBe('± 20-25 deelnemers');
    expect(formatGroupSize('max 15')).toBe('max 15 deelnemers');
    expect(formatGroupSize('+/- 10')).toBe('+/- 10 deelnemers');
  });

  it('herhaalt het woord deelnemers niet', () => {
    expect(formatGroupSize('3 groepen à 10 deelnemers')).toBe('3 groepen à 10 deelnemers');
    expect(formatGroupSize('Max. 15 deelnemers')).toBe('Max. 15 deelnemers');
  });
});

describe('formatLanguage', () => {
  it('kent de vier waarden die het bord heeft', () => {
    expect(formatLanguage('NL')).toBe('Nederlands');
    expect(formatLanguage('ENG')).toBe('Engels');
    expect(formatLanguage('NL + ENG')).toBe('Nederlands + Engels');
    expect(formatLanguage('')).toBe('');
  });

  /** Een nieuwe code moet opvallen in de briefing, niet stilletjes verdwijnen. */
  it('geeft een onbekende code onveranderd door', () => {
    expect(formatLanguage('DE')).toBe('DE');
  });
});

describe('formatClientContact', () => {
  it('zet de ITG-accountwaarschuwing bij Teams', () => {
    expect(formatClientContact('Teams')).toBe('Via Teams, let op: gebruik ITG-account');
  });

  it('laat de overige statuswaarden met rust', () => {
    expect(formatClientContact('Niet nodig')).toBe('Niet nodig');
    expect(formatClientContact('Proces klaar')).toBe('Proces klaar');
    expect(formatClientContact('klantcontact')).toBe('klantcontact');
  });
});

describe('formatEvaluation', () => {
  /**
   * De QR-kolom is een werkstroomkolom: `Aanmaken`, `Staat klaar` en `Verzonden` zijn
   * stappen in het maken van de code, niet het antwoord op "wordt er geëvalueerd". Alleen
   * `Geen QR (deze sessie)` is een bevestigd nee.
   */
  it('leest alleen "geen QR" als nee', () => {
    expect(formatEvaluation('Geen QR (deze sessie)')).toBe('Nee');
    for (const raw of ['Verzonden', 'Aanmaken', 'Staat klaar', 'NL Aanmaken', 'EN Aanmaken']) {
      expect(formatEvaluation(raw)).toBe('Ja, gebruik de QR code');
    }
  });

  /**
   * `NOTK` is nog te kennen: de keuze is niet gemaakt. `Ja, gebruik de QR code` is geen
   * aanname maar een instructie, en de trainer zou aan het eind van de sessie een code
   * ophangen die niet bestaat. 17 trainingen staan hierop.
   */
  it('maakt van NOTK geen bevestigd ja', () => {
    const uitkomst = formatEvaluation('0. NOTK');
    expect(uitkomst).not.toContain('Ja');
    expect(uitkomst).toContain('nog niet bepaald');
    expect(uitkomst).toContain('0. NOTK');
  });

  it('verzint niets bij een lege kolom', () => {
    expect(formatEvaluation('')).toBe('');
  });
});

describe('formatTravel', () => {
  it('reproduceert de regel uit de voorbeeldbriefing', () => {
    expect(formatTravel({ roundTripKm: 126, roundTripMinutes: 100, thresholdMinutes: 90 })).toBe(
      'Totaal: 126 km. / Totaal: 100 min. (10 min. factureren)'
    );
  });

  /** `(0 min. factureren)` zou lezen als een afspraak die niemand heeft gemaakt. */
  it('laat het factureerdeel weg onder de drempel', () => {
    expect(formatTravel({ roundTripKm: 12.4, roundTripMinutes: 30, thresholdMinutes: 90 })).toBe(
      'Totaal: 12 km. / Totaal: 30 min.'
    );
  });
});
