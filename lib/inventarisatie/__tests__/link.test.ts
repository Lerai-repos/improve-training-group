import { describe, expect, it } from 'vitest';

import { gewensteLink, inventarisatieLink, labelVanOpportunity } from '../link';

import type { LabelCode } from '@lib/labels';

const WEBSITES: ReadonlyMap<LabelCode, string> = new Map<LabelCode, string>([
  ['IT', 'https://www.incompanytrainer.nl'],
  ['WJ', 'https://www.workjoy.nl/'],
  ['FT', ''],
  ['ITG', 'https://www.improvetraininggroup.nl'],
]);

describe('labelVanOpportunity', () => {
  /** De kolom Label op de Opportunity mengt codes en volledige namen. */
  it('leest codes en volledige namen als hetzelfde label, op nummer', () => {
    expect(labelVanOpportunity(1, 'IT')).toBe('IT');
    expect(labelVanOpportunity(9, 'Incompany Trainer')).toBe('IT');
    expect(labelVanOpportunity(2, 'WJ')).toBe('WJ');
    expect(labelVanOpportunity(7, 'WorkJoy')).toBe('WJ');
    expect(labelVanOpportunity(16, 'Communicatie Plus')).toBe('CP');
  });

  /** Een hernoemd label van de negen blijft hetzelfde label. */
  it('volgt voor de negen het nummer en niet de tekst', () => {
    expect(labelVanOpportunity(9, 'Incompany Trainer (oud)')).toBe('IT');
  });

  /** Een label dat ITG later toevoegt (17 `ITG`) werkt op zijn tekst, zonder code. */
  it('gaat voor elk ander nummer op de tekst van het label', () => {
    expect(labelVanOpportunity(17, 'ITG')).toBe('ITG');
    expect(labelVanOpportunity(18, ' itg ')).toBe('ITG');
    expect(labelVanOpportunity(14, 'Email')).toBe('EMAIL');
  });

  /** 8 is `Feedbacktrainer`, oftewel FT, en dat heet nu "Feedback Trainer". */
  it('laat een vast nummer door de sleutel lopen, zodat het hernoemde FT gevonden wordt', () => {
    expect(labelVanOpportunity(8, 'Feedbacktrainer')).toBe('FEEDBACK TRAINER');
    expect(
      gewensteLink(
        { itemId: '42', labelIndex: 8, labelTekst: 'Feedbacktrainer' },
        new Map([['FEEDBACK TRAINER', 'https://www.feedbacktrainer.nl/']])
      )
    ).toBe('https://www.feedbacktrainer.nl/inventarisatie?reference_id=42');
  });

  it('kent geen label voor een lege cel', () => {
    expect(labelVanOpportunity(null, '')).toBeNull();
    expect(labelVanOpportunity(5, '')).toBeNull();
  });
});

describe('inventarisatieLink', () => {
  it('bouwt de link op de website van het label, met de Opportunity als referentie', () => {
    expect(inventarisatieLink('https://www.incompanytrainer.nl', '3167133931')).toBe(
      'https://www.incompanytrainer.nl/inventarisatie?reference_id=3167133931'
    );
  });

  it('negeert een slash of pad achter de website', () => {
    expect(inventarisatieLink('https://www.workjoy.nl/', '1')).toBe(
      'https://www.workjoy.nl/inventarisatie?reference_id=1'
    );
    expect(inventarisatieLink('https://www.workjoy.nl/over-ons', '1')).toBe(
      'https://www.workjoy.nl/inventarisatie?reference_id=1'
    );
  });

  it('geeft geen link zonder website, of met een website die geen adres is', () => {
    expect(inventarisatieLink('', '1')).toBeNull();
    expect(inventarisatieLink('workjoy', '1')).toBeNull();
  });
});

describe('gewensteLink', () => {
  it('geeft de link voor een label met een website', () => {
    expect(
      gewensteLink({ itemId: '42', labelIndex: 9, labelTekst: 'Incompany Trainer' }, WEBSITES)
    ).toBe('https://www.incompanytrainer.nl/inventarisatie?reference_id=42');
  });

  it('geeft de link voor een label dat ITG zelf toevoegde', () => {
    expect(gewensteLink({ itemId: '42', labelIndex: 17, labelTekst: 'ITG' }, WEBSITES)).toBe(
      'https://www.improvetraininggroup.nl/inventarisatie?reference_id=42'
    );
  });

  it('geeft geen link voor een label zonder website of zonder rij op het Labels-bord', () => {
    expect(
      gewensteLink({ itemId: '42', labelIndex: 8, labelTekst: 'Feedbacktrainer' }, WEBSITES)
    ).toBeNull();
    expect(
      gewensteLink({ itemId: '42', labelIndex: 14, labelTekst: 'Email' }, WEBSITES)
    ).toBeNull();
    expect(gewensteLink({ itemId: '42', labelIndex: 10, labelTekst: 'CC' }, WEBSITES)).toBeNull();
  });
});
