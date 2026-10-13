import { describe, expect, it } from 'vitest';

import { gewensteLink, inventarisatieLink, labelVanOpportunity } from '../link';

import type { LabelCode } from '@lib/labels';

const WEBSITES: ReadonlyMap<LabelCode, string> = new Map<LabelCode, string>([
  ['IT', 'https://www.incompanytrainer.nl'],
  ['WJ', 'https://www.workjoy.nl/'],
  ['FT', ''],
]);

describe('labelVanOpportunity', () => {
  /** De kolom Label op de Opportunity mengt codes en volledige namen. */
  it('leest codes en volledige namen als hetzelfde label', () => {
    expect(labelVanOpportunity(1)).toBe('IT');
    expect(labelVanOpportunity(9)).toBe('IT');
    expect(labelVanOpportunity(2)).toBe('WJ');
    expect(labelVanOpportunity(7)).toBe('WJ');
    expect(labelVanOpportunity(16)).toBe('CP');
  });

  it('kent geen label voor Email, TMT, ITG, StressTrainer of een lege cel', () => {
    for (const nummer of [14, 15, 17, 11, 5]) {
      expect(labelVanOpportunity(nummer)).toBeNull();
    }
    expect(labelVanOpportunity(null)).toBeNull();
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
    expect(gewensteLink({ itemId: '42', labelIndex: 9 }, WEBSITES)).toBe(
      'https://www.incompanytrainer.nl/inventarisatie?reference_id=42'
    );
  });

  it('geeft geen link voor een label zonder website of een onbekend label', () => {
    expect(gewensteLink({ itemId: '42', labelIndex: 8 }, WEBSITES)).toBeNull();
    expect(gewensteLink({ itemId: '42', labelIndex: 14 }, WEBSITES)).toBeNull();
    expect(gewensteLink({ itemId: '42', labelIndex: 10 }, WEBSITES)).toBeNull();
  });
});
