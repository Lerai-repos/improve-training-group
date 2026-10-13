import { describe, expect, it } from 'vitest';

import { LABEL_CODES, LABEL_SEED, isLabelCode } from '../catalog';
import { describeProblem, normaliseHex, validateCatalog } from '../validate';

import type { LabelConfig } from '../types';

const base: LabelConfig = {
  code: 'IT',
  volledigeNaam: 'Incompany Trainer',
  kleur: '#0A2B58',
  term: 'Training',
  rapportterm: 'de training',
  evaluatieformulier: '',
  website: '',
};

/** De negen labels, minimaal ingevuld — de basis waar elke test één ding aan stukmaakt. */
const complete = (): LabelConfig[] =>
  LABEL_CODES.map((code) => ({ ...base, code, volledigeNaam: `Label ${code}` }));

describe('normaliseHex', () => {
  it('hoogt kleine letters op zodat #265e5d en #265E5D dezelfde kleur zijn', () => {
    expect(normaliseHex('#265e5d')).toBe('#265E5D');
    expect(normaliseHex('#265E5D')).toBe('#265E5D');
  });

  it('accepteert spatie eromheen, want een gekopieerde waarde heeft die vaak', () => {
    expect(normaliseHex('  #0A2B58 ')).toBe('#0A2B58');
  });

  it.each(['0A2B58', '#0A2B5', '#0A2B58F', '#GGGGGG', '', 'blauw', 'rgb(0,0,0)'])(
    'weigert %j',
    (value) => {
      expect(normaliseHex(value)).toBeNull();
    }
  );
});

describe('validateCatalog', () => {
  it('keurt een volledige, correcte verzameling goed', () => {
    expect(validateCatalog(complete())).toEqual([]);
  });

  /** Welke labels er zijn beslist het bord, niet de code. */
  it('meldt geen ontbrekend of nieuw label', () => {
    const rows = complete().filter((r) => r.code !== 'FT');
    expect(validateCatalog([...rows, { ...base, code: 'ITG' }])).toEqual([]);
  });

  /**
   * Twee rijen voor hetzelfde label is erger dan geen rij: welke van de twee de huisstijl
   * bepaalt hangt dan af van de volgorde waarin Monday ze teruggeeft.
   */
  it('meldt een dubbel label', () => {
    const rows = [...complete(), { ...base, code: 'it' }];
    expect(validateCatalog(rows)).toContainEqual({ kind: 'duplicate_label', code: 'it' });
  });

  it('meldt een kleur die geen hex is', () => {
    const rows = complete();
    rows[0] = { ...rows[0], kleur: 'donkerblauw' };
    expect(validateCatalog(rows)).toContainEqual({
      kind: 'bad_colour',
      code: 'IT',
      found: 'donkerblauw',
    });
  });

  /**
   * Een lege kleur is één probleem, niet twee. Zonder de non-empty-guard in `validateCatalog`
   * zou hij zowel `empty_field` als `bad_colour` opleveren en leest de melding als twee
   * losse fouten in dezelfde cel.
   */
  it('meldt een lege kleur één keer, niet ook als ongeldige hex', () => {
    const rows = complete();
    rows[0] = { ...rows[0], kleur: '   ' };
    const problems = validateCatalog(rows).filter((p) => 'code' in p && p.code === 'IT');
    expect(problems).toEqual([{ kind: 'empty_field', code: 'IT', field: 'Kleur' }]);
  });

  /**
   * De website mag leeg zijn zonder het rapport tegen te houden — FT staat vandaag zo op het
   * bord.
   */
  it('laat een lege website ongemoeid', () => {
    expect(validateCatalog(complete())).toEqual([]);
  });

  it('verzamelt ALLE problemen in plaats van bij de eerste te stoppen', () => {
    const rows = complete();
    rows[0] = { ...rows[0], kleur: 'x', volledigeNaam: '' };
    rows[1] = { ...rows[1], rapportterm: '' };
    const problems = validateCatalog(rows);
    expect(problems.map((p) => p.kind)).toEqual(['empty_field', 'bad_colour', 'empty_field']);
  });
});

describe('LABEL_SEED', () => {
  it('bevat precies de negen labels uit LABEL_CODES, in dezelfde volgorde', () => {
    expect(LABEL_SEED.map((l) => l.code)).toEqual([...LABEL_CODES]);
  });

  /** De seed is wat er op het bord komt te staan; hij moet zijn eigen keuring doorstaan. */
  it('doorstaat validateCatalog', () => {
    expect(validateCatalog(LABEL_SEED).map(describeProblem)).toEqual([]);
  });

  it('heeft voor elk label een kleur die als hex leesbaar is', () => {
    for (const label of LABEL_SEED) {
      expect(normaliseHex(label.kleur), `${label.code} kleur`).not.toBeNull();
    }
  });

  /**
   * De gemeten gaten van 1-Sep-2026, vastgelegd zodat het opvullen ervan een bewuste
   * wijziging is en niet iets wat ongemerkt wegdrijft.
   */
  it('laat exact de gemeten velden leeg', () => {
    const leeg = LABEL_SEED.flatMap((l) =>
      (['evaluatieformulier', 'website'] as const)
        .filter((f) => l[f] === '')
        .map((f) => `${l.code}.${f}`)
    );
    expect(leeg.sort()).toEqual(
      ['FT.evaluatieformulier', 'FT.website'].sort()
    );
  });
});

describe('isLabelCode', () => {
  it.each(['IT', 'FT', 'CP'])('herkent %s', (code) => {
    expect(isLabelCode(code)).toBe(true);
  });

  /** De vier die live op de agenda staan zonder configuratie. */
  it.each(['YNS', 'TMT', 'ST - StressTrainer', 'Email', 'WorkJoy', ''])(
    'herkent %j niet',
    (code) => {
      expect(isLabelCode(code)).toBe(false);
    }
  );
});
