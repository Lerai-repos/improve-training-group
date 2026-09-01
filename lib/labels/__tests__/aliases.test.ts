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
   * De vier die live op de agenda staan zonder configuratie, samen 19 trainingen. Er is geen
   * merk om ze op te laten wijzen; raden zou een rapport in de huisstijl van een ánder bedrijf
   * opleveren. Ze horen `null` te geven zodat de aanroeper ze kan melden.
   */
  it.each(['YNS', 'TMT', 'ST - StressTrainer', 'Email'])(
    'weigert het onbekende label %j te raden',
    (raw) => {
      expect(resolveLabelCode(raw)).toBeNull();
    }
  );

  it('geeft null voor leeg', () => {
    expect(resolveLabelCode('')).toBeNull();
    expect(resolveLabelCode('   ')).toBeNull();
  });
});

describe('isLabelCode blijft strikt', () => {
  /**
   * De itemnaam op het Labels-bord IS de code. Zou `isLabelCode` de schrijfwijzen accepteren,
   * dan kon er een rij "WorkJoy" naast de rij "WJ" ontstaan: twee rijen, één merk, en welke
   * van de twee de huisstijl bepaalt hangt af van de volgorde van Monday.
   */
  it.each(Object.keys(LABEL_ALIASES))('accepteert de schrijfwijze %j niet als bordrij', (alias) => {
    expect(isLabelCode(alias)).toBe(false);
  });

  it('wijst elke schrijfwijze naar een bestaande code', () => {
    for (const code of Object.values(LABEL_ALIASES)) {
      expect(isLabelCode(code)).toBe(true);
    }
  });
});
