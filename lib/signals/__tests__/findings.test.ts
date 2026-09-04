import { describe, expect, it } from 'vitest';

import { labelFindings, themaFindings, unusableLabelFields } from '../findings';
import { isChecked } from '../read';

import type { LabelCode } from '@lib/labels';
import type { LabelRecord } from '@lib/labels/read';
import type { AgendaUsage, ThemaRecord } from '../findings';

const asset = { id: 'a', name: 'n', publicUrl: 'https://x' };

function record(over: Partial<LabelRecord> = {}): LabelRecord {
  return {
    code: 'IT',
    volledigeNaam: 'Incompany Trainer',
    kleur: '#0A2B58',
    term: 'Training',
    rapportterm: 'de training',
    evaluatieformulier: '',
    website: '',
    inventarisatieformulier: '',
    logo: asset,
    voorblad: asset,
    achterblad: asset,
    ...over,
  };
}

function usage(over: Partial<AgendaUsage> = {}): AgendaUsage {
  return { labels: new Map(), themas: new Map(), trainers: new Map(), ...over };
}

const configured = (...pairs: ReadonlyArray<readonly [LabelCode, LabelRecord]>) =>
  new Map<LabelCode, LabelRecord>(pairs);

describe('unusableLabelFields', () => {
  it('noemt niets als alles gevuld is', () => {
    expect(unusableLabelFields(record())).toEqual([]);
  });

  it('kijkt NIET naar de velden die nog door niets gelezen worden', () => {
    // Alle drie leeg in `record()`. Zouden ze meetellen, dan meldt de controle op dag één
    // vijf bekende gaten die niemand hoeft op te lossen.
    const leeg = unusableLabelFields(
      record({ evaluatieformulier: '', website: '', inventarisatieformulier: '' })
    );
    expect(leeg).toEqual([]);
  });

  it('meldt een leeg bestandsveld', () => {
    expect(unusableLabelFields(record({ voorblad: null }))).toEqual([
      { veld: 'voorblad', reden: 'leeg' },
    ]);
  });

  it('behandelt witruimte als leeg', () => {
    expect(unusableLabelFields(record({ rapportterm: '   ' }))).toEqual([
      { veld: 'rapportterm', reden: 'leeg' },
    ]);
  });
});

describe('labelFindings', () => {
  it('meldt een labelwaarde die door niets wordt herkend', () => {
    const found = labelFindings(usage({ labels: new Map([['TMT', 7]]) }), configured());
    expect(found).toEqual([{ kind: 'onbekend-label', label: 'TMT', trainingen: 7 }]);
  });

  it('telt een alias op bij de canonieke code in plaats van hem onbekend te noemen', () => {
    // `WorkJoy` en `WJ` staan allebei op de agenda; het is één label.
    const found = labelFindings(
      usage({
        labels: new Map([
          ['WJ', 60],
          ['WorkJoy', 5],
        ]),
      }),
      configured()
    );
    expect(found).toEqual([{ kind: 'label-ontbreekt', code: 'WJ', trainingen: 65 }]);
  });

  it('slaat een lege labelcel over — dat is geen onbekend label', () => {
    const found = labelFindings(usage({ labels: new Map([['', 12]]) }), configured());
    expect(found).toEqual([]);
  });

  it('zwijgt over een label dat volledig is ingesteld', () => {
    const found = labelFindings(
      usage({ labels: new Map([['IT', 527]]) }),
      configured(['IT', record()])
    );
    expect(found).toEqual([]);
  });

  it('meldt welke velden leeg zijn', () => {
    const found = labelFindings(
      usage({ labels: new Map([['IT', 527]]) }),
      configured(['IT', record({ logo: null, kleur: '' })])
    );
    expect(found).toEqual([
      {
        kind: 'label-onvolledig',
        code: 'IT',
        velden: [
          { veld: 'kleur', reden: 'leeg' },
          { veld: 'logo', reden: 'leeg' },
        ],
        trainingen: 527,
      },
    ]);
  });

  it('meldt niets over een geconfigureerd label dat op nul trainingen staat', () => {
    // CP staat wél op het Labels-bord maar wordt nergens gebruikt. Een leeg veld daar breekt
    // niets, dus het hoort niemand wakker te maken.
    const found = labelFindings(usage(), configured(['CP', record({ code: 'CP', logo: null })]));
    expect(found).toEqual([]);
  });

  it('houdt een vaste volgorde aan, ongeacht de leesvolgorde van de agenda', () => {
    const heen = labelFindings(
      usage({
        labels: new Map([
          ['JE', 1],
          ['IT', 1],
        ]),
      }),
      configured()
    );
    const terug = labelFindings(
      usage({
        labels: new Map([
          ['IT', 1],
          ['JE', 1],
        ]),
      }),
      configured()
    );
    expect(heen).toEqual(terug);
    expect(heen.map((f) => (f.kind === 'label-ontbreekt' ? f.code : ''))).toEqual(['IT', 'JE']);
  });
});

describe('themaFindings', () => {
  const live = (...pairs: ReadonlyArray<readonly [string, ThemaRecord]>) =>
    new Map<string, ThemaRecord>(pairs);

  it('meldt een verwijzing naar een thema dat niet meer bestaat', () => {
    const found = themaFindings(usage({ themas: new Map([['999', 3]]) }), live());
    expect(found).toEqual([{ kind: 'thema-ontbreekt', themaId: '999', trainingen: 3 }]);
  });

  it('meldt een thema zonder concept-inhoud', () => {
    const found = themaFindings(
      usage({ themas: new Map([['12', 37]]) }),
      live(['12', { naam: 'Veranderen', conceptInhoud: '' }])
    );
    expect(found).toEqual([
      { kind: 'thema-zonder-inhoud', themaId: '12', naam: 'Veranderen', trainingen: 37 },
    ]);
  });

  it('zwijgt over een thema dat wél inhoud heeft', () => {
    const found = themaFindings(
      usage({ themas: new Map([['12', 37]]) }),
      live(['12', { naam: 'Veranderen', conceptInhoud: '- iets' }])
    );
    expect(found).toEqual([]);
  });

  it('zwijgt over een leeg thema dat door geen enkele training wordt gebruikt', () => {
    // Zes van zulke thema's staan er nu op het bord. Ze kunnen geen briefing breken.
    const found = themaFindings(usage(), live(['12', { naam: 'Ongebruikt', conceptInhoud: '' }]));
    expect(found).toEqual([]);
  });
});

describe('isChecked', () => {
  /**
   * Geschreven met de twee vormen NAAST elkaar, niet met één gekozen vorm overal.
   *
   * Monday geeft `CheckboxValue.checked` op API 2026-07 terug als een echte boolean; de
   * `value`-JSON van dezelfde kolom draagt hem als string. Een test die overal dezelfde vorm
   * gebruikt bevestigt alleen wat de implementatie toevallig doet — en de fout die dit
   * afvangt is stil: een vinkje dat altijd als uit leest, waardoor afvinken niets doet.
   */
  it('herkent de boolean die Monday echt teruggeeft', () => {
    expect(isChecked({ checked: true })).toBe(true);
    expect(isChecked({ checked: false })).toBe(false);
  });

  it('herkent ook de stringvorm', () => {
    expect(isChecked({ checked: 'true' })).toBe(true);
    expect(isChecked({ checked: 'false' })).toBe(false);
  });

  it('leest een leeg vinkje als uit', () => {
    expect(isChecked(undefined)).toBe(false);
    expect(isChecked({})).toBe(false);
    expect(isChecked({ checked: null })).toBe(false);
  });
});

describe('unusableLabelFields — een kleur die geen kleur is', () => {
  /**
   * Zou een onleesbare hexwaarde alleen de strikte lezer laten werpen, dan valt de hele
   * labelcontrole om voor één typefout in één cel — inclusief de meldingen over onbekende
   * labels, die met dat veld niets te maken hebben.
   */
  it('meldt een onleesbare kleur als onbruikbaar veld', () => {
    // Niet "leeg": het veld ís ingevuld, alleen niet in een vorm die het rapport kan gebruiken.
    expect(unusableLabelFields(record({ kleur: 'blauw' }))).toEqual([
      { veld: 'kleur', reden: 'ongeldig' },
    ]);
  });

  it('accepteert een geldige hexwaarde', () => {
    expect(unusableLabelFields(record({ kleur: '#0A2B58' }))).toEqual([]);
  });
});
