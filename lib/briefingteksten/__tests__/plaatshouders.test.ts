import { describe, expect, it } from 'vitest';

import { bevat, controleerPlaatshouders, vulIn } from '../plaatshouders';

describe('controleerPlaatshouders', () => {
  it('keurt {merk} en {term} overal goed', () => {
    expect(controleerPlaatshouders('Namens {merk} een {term}.', [])).toBeNull();
  });

  it('is niet streng op hoofdletters en spaties binnen de accolades', () => {
    expect(controleerPlaatshouders('Namens { Merk } een {TERM}.', [])).toBeNull();
  });

  it('meldt een tikfout en zegt wat hier wél kan', () => {
    expect(controleerPlaatshouders('Namens {mrek}.', ['trainers'])).toBe(
      'Onbekende plaatshouder {mrek}. Hier kan: {merk}, {term}, {trainers}.'
    );
  });

  /** `{trainers}` bestaat, maar in het huiswerkblok is er niemand om in te vullen. */
  it('meldt een plaatshouder die bestaat maar in deze sectie niet kan', () => {
    expect(controleerPlaatshouders('Met {trainers}.', [])).toMatch(/^Onbekende plaatshouder/);
  });

  it('noemt elke onbekende plaatshouder één keer', () => {
    expect(controleerPlaatshouders('{x} en {y} en {x}', [])).toMatch(
      /^Onbekende plaatshouders \{x\}, \{y\}\./
    );
  });

  it('meldt een losse accolade', () => {
    expect(controleerPlaatshouders('Namens {merk en verder.', [])).toMatch(/^Losse accolade/);
    expect(controleerPlaatshouders('Namens merk} en verder.', [])).toMatch(/^Losse accolade/);
  });
});

describe('vulIn', () => {
  it('vult elke schrijfwijze in', () => {
    expect(vulIn('{merk} / { Merk } / {TERM}', { merk: 'WorkJoy', term: 'workshop' })).toBe(
      'WorkJoy / WorkJoy / workshop'
    );
  });

  it('laat een plaatshouder zonder waarde zichtbaar staan', () => {
    expect(vulIn('Met {trainers}.', { merk: 'X' })).toBe('Met {trainers}.');
  });
});

describe('bevat', () => {
  it('vindt een plaatshouder in elke schrijfwijze', () => {
    expect(bevat('van { Duur } uur', 'duur')).toBe(true);
    expect(bevat('van vier uur', 'duur')).toBe(false);
  });
});
