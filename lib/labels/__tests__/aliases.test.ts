import { describe, expect, it } from 'vitest';

import { LABEL_ALIASES, isLabelCode, resolveLabelCode } from '../catalog';

/**
 * De agenda's statuskolom `status23` definieert zestien labels. Deze test legt vast welke
 * daarvan waar naartoe wijzen, en — belangrijker — welke bewust nergens naartoe wijzen.
 */
describe('resolveLabelCode', () => {
  it.each([
    ['IT', 'IT'],
    ['FT', 'FT'],
    ['CC', 'CC'],
  ])('laat de canonieke code %s ongemoeid', (raw, expected) => {
    expect(resolveLabelCode(raw)).toBe(expected);
  });

  it.each([
    ['WorkJoy', 'WJ'],
    ['Feedbacktrainer', 'FT'],
    ['Company Cursus', 'CC'],
  ])('lost de schrijfwijze %s op naar %s', (raw, expected) => {
    expect(resolveLabelCode(raw)).toBe(expected);
  });

  it('is hoofdletterongevoelig en negeert omringende spaties', () => {
    expect(resolveLabelCode('  workjoy ')).toBe('WJ');
    expect(resolveLabelCode('WORKJOY')).toBe('WJ');
    expect(resolveLabelCode(' it ')).toBe('IT');
    expect(resolveLabelCode('sst')).toBe('SST');
  });

  /**
   * Sinds 13-Oct-2026 is elke waarde zijn eigen label: of het werkt beslist het Labels-bord. De
   * vier die vandaag zonder rij op de agenda staan raden we nog steeds niet naar een ander merk;
   * ze krijgen hun eigen sleutel, en zonder rij meldt de dagelijkse controle ze.
   */
  it.each([
    ['YNS', 'YNS'],
    ['TMT', 'TMT'],
    ['ST - StressTrainer', 'ST - STRESSTRAINER'],
    ['Email', 'EMAIL'],
    [' itg ', 'ITG'],
  ])('geeft %j zijn eigen sleutel %j in plaats van te raden', (raw, expected) => {
    expect(resolveLabelCode(raw)).toBe(expected);
  });

  it('geeft null voor leeg', () => {
    expect(resolveLabelCode('')).toBeNull();
    expect(resolveLabelCode('   ')).toBeNull();
  });
});

describe('isLabelCode blijft strikt', () => {
  /**
   * `isLabelCode` zegt of iets een van de negen oorspronkelijke labels is, letterlijk. Een
   * schrijfwijze is dat niet: die wijst naar zo'n label, maar is er zelf geen.
   */
  it.each(Object.keys(LABEL_ALIASES))('accepteert de schrijfwijze %j niet als label', (alias) => {
    expect(isLabelCode(alias)).toBe(false);
  });

  it('wijst elke schrijfwijze naar een bestaande code', () => {
    for (const code of Object.values(LABEL_ALIASES)) {
      expect(isLabelCode(code)).toBe(true);
    }
  });
});
