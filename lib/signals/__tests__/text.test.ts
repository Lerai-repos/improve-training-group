import { describe, expect, it } from 'vitest';

import { findingDetail, findingName, rowForFinding } from '../text';

import type { Finding } from '../types';

/**
 * De naam is de vingerafdruk waarmee `reconcile` beslist of een melding moet worden
 * bijgewerkt. Draagt een variant niet ál zijn veranderlijke waarden in de naam, dan blijft het
 * bord een verouderd getal tonen zonder dat er iets fout gaat — precies wat er met
 * `label-onvolledig` gebeurde, waar alleen de veldenlijst in de naam stond.
 *
 * Elke regel hieronder is één veranderlijk veld van één variant. Komt er een variant of een
 * veld bij, dan hoort hier een regel bij.
 */
const paren: ReadonlyArray<readonly [string, Finding, Finding]> = [
  [
    'eval-knop / reden',
    {
      kind: 'eval-knop',
      itemId: '1',
      klanttitel: 'RSV',
      datum: '2026-09-17',
      reden: 'Er is geen trainer gekoppeld aan deze training.',
    },
    {
      kind: 'eval-knop',
      itemId: '1',
      klanttitel: 'RSV',
      datum: '2026-09-17',
      reden: 'De training heeft geen datum.',
    },
  ],
  [
    'onbekend-label / aantal',
    { kind: 'onbekend-label', label: 'TMT', trainingen: 7 },
    { kind: 'onbekend-label', label: 'TMT', trainingen: 40 },
  ],
  [
    'onbekend-label / label',
    { kind: 'onbekend-label', label: 'TMT', trainingen: 7 },
    { kind: 'onbekend-label', label: 'YNS', trainingen: 7 },
  ],
  [
    'label-ontbreekt / aantal',
    { kind: 'label-ontbreekt', code: 'CC', trainingen: 9 },
    { kind: 'label-ontbreekt', code: 'CC', trainingen: 90 },
  ],
  [
    'label-onvolledig / aantal',
    {
      kind: 'label-onvolledig',
      code: 'CC',
      velden: [{ veld: 'logo', reden: 'leeg' }],
      trainingen: 7,
    },
    {
      kind: 'label-onvolledig',
      code: 'CC',
      velden: [{ veld: 'logo', reden: 'leeg' }],
      trainingen: 40,
    },
  ],
  [
    'label-onvolledig / velden',
    {
      kind: 'label-onvolledig',
      code: 'CC',
      velden: [{ veld: 'logo', reden: 'leeg' }],
      trainingen: 7,
    },
    {
      kind: 'label-onvolledig',
      code: 'CC',
      velden: [
        { veld: 'logo', reden: 'leeg' },
        { veld: 'kleur', reden: 'leeg' },
      ],
      trainingen: 7,
    },
  ],
  [
    'thema-ontbreekt / aantal',
    { kind: 'thema-ontbreekt', themaId: '12', trainingen: 3 },
    { kind: 'thema-ontbreekt', themaId: '12', trainingen: 30 },
  ],
  [
    'thema-zonder-inhoud / aantal',
    { kind: 'thema-zonder-inhoud', themaId: '12', naam: 'Veranderen', trainingen: 37 },
    { kind: 'thema-zonder-inhoud', themaId: '12', naam: 'Veranderen', trainingen: 370 },
  ],
  [
    'thema-zonder-inhoud / naam',
    { kind: 'thema-zonder-inhoud', themaId: '12', naam: 'Veranderen', trainingen: 37 },
    { kind: 'thema-zonder-inhoud', themaId: '12', naam: 'Boksen', trainingen: 37 },
  ],
];

describe('findingName draagt élke veranderlijke waarde', () => {
  it.each(paren)('%s', (_wat, een, twee) => {
    expect(findingName(een)).not.toBe(findingName(twee));
  });
});

describe('findingDetail volgt de naam', () => {
  /**
   * Als het Detail een waarde noemt die de naam niet noemt, kan dat Detail verouderen zonder
   * dat er ooit een update komt. Deze test dwingt af dat de twee dezelfde gegevens dragen.
   */
  it.each(paren)('%s', (_wat, een, twee) => {
    expect(findingDetail(een)).not.toBe(findingDetail(twee));
  });
});

describe('findingName', () => {
  it('noemt het aantal trainingen bij een onvolledig label', () => {
    const naam = findingName({
      kind: 'label-onvolledig',
      code: 'CC',
      velden: [{ veld: 'logo', reden: 'leeg' }],
      trainingen: 9,
    });
    expect(naam).toContain('logo');
    expect(naam).toContain('9 trainingen');
  });

  it('noemt een ongeldige kleur niet leeg, en geeft de juiste reparatie', () => {
    const finding: Finding = {
      kind: 'label-onvolledig',
      code: 'CC',
      velden: [{ veld: 'kleur', reden: 'ongeldig' }],
      trainingen: 9,
    };
    expect(findingName(finding)).toContain('kleur ongeldig');

    const detail = findingDetail(finding);
    expect(detail).toContain('#RRGGBB');
    // "Vul het in" is precies de verkeerde instructie: het veld ís ingevuld.
    expect(detail).not.toContain('leeg — vul het in');
  });

  it('gebruikt enkelvoud bij één training', () => {
    expect(findingName({ kind: 'onbekend-label', label: 'Email', trainingen: 1 })).toContain(
      '1 training'
    );
  });
});

/**
 * Monday weigert een itemnaam van 256 tekens of meer, en dan breekt de hele controle af —
 * gemeten 12-Oct-2026 op de eerste melding van de knop Eval Rapport, waarvan de reden in de
 * naam stond.
 */
describe('de naam van een melding past in Monday', () => {
  const lang = {
    kind: 'eval-knop' as const,
    itemId: '2912597013',
    klanttitel: 'RSV Breda e.o. VO (copy)',
    datum: '2026-09-17',
    reden:
      'IE-code 260814 staat ook op een andere training (item 2802085605, 28-08-2026), en het ' +
      'is niet te zien bij welke sessie de reacties horen. Haal de code weg op de training ' +
      'waar hij niet hoort, of koppel op beide hetzelfde bedrijf als het één sessie is.',
  };

  it('neemt van de knopreden alleen de eerste zin in de naam op', () => {
    const naam = rowForFinding(lang).naam;
    expect(naam).toContain('IE-code 260814 staat ook op een andere training');
    expect(naam).not.toContain('Haal de code weg');
    // De hele reden staat in het detail.
    expect(rowForFinding(lang).detail).toContain('Haal de code weg');
  });

  it('kapt elke naam af onder de grens van Monday', () => {
    const enorm = { ...lang, klanttitel: 'x'.repeat(400) };
    const naam = rowForFinding(enorm).naam;
    expect(Array.from(naam).length).toBeLessThanOrEqual(255);
    expect(naam.endsWith('…')).toBe(true);
  });

  /** Elke run dezelfde naam, anders ziet de verzoening er elke nacht een wijziging in. */
  it('kapt elke keer op dezelfde plek af', () => {
    const enorm = { ...lang, klanttitel: 'x'.repeat(400) };
    expect(rowForFinding(enorm).naam).toBe(rowForFinding(enorm).naam);
  });
});
