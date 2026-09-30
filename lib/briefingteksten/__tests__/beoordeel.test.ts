import { describe, expect, it } from 'vitest';

import { beoordeel, beoordeelAlle } from '../beoordeel';
import { SECTIES, uitlegVoor } from '../catalog';
import { parseRegels } from '../regels';
import { standaardTeksten, tekstenUit } from '../teksten';

import type { TekstRij } from '../beoordeel';

const rij = (overrides: Partial<TekstRij> = {}): TekstRij => ({
  itemId: '1',
  naam: 'Huiswerkopdracht',
  sleutel: 'opdracht.huiswerk',
  kop: 'Huiswerkopdracht',
  tekst: 'Doe het huiswerk.',
  status: '',
  melding: '',
  ...overrides,
});

describe('beoordeel', () => {
  it('keurt een gewone tekst goed', () => {
    const oordeel = beoordeel(rij(), false);
    expect(oordeel.status).toBe('OK');
    expect(oordeel.melding).toBe('');
    expect(oordeel.staat).toEqual({
      kind: 'tekst',
      kop: 'Huiswerkopdracht',
      regels: [{ tekst: 'Doe het huiswerk.', bullet: false, niveau: 0 }],
    });
  });

  /** Tim, 30-Sep-2026: leeg is een keuze, en dan verdwijnt de sectie. */
  it('maakt van een lege tekst een lege sectie, ook met een kop', () => {
    const oordeel = beoordeel(rij({ tekst: ' \n ' }), false);
    expect(oordeel.status).toBe('Leeg');
    expect(oordeel.staat).toEqual({ kind: 'leeg' });
  });

  it('keurt een onbekende plaatshouder af, in de tekst en in de kop', () => {
    expect(beoordeel(rij({ tekst: 'Namens {mrek}.' }), false).status).toBe('Fout');
    const kop = beoordeel(rij({ kop: 'Huiswerk voor {trainers}' }), false);
    expect(kop.status).toBe('Fout');
    expect(kop.staat.kind).toBe('fout');
  });

  it('keurt een kop af op een sectie die er geen heeft', () => {
    const oordeel = beoordeel(
      rij({ sleutel: 'cyclus.huiswerk', kop: 'Iets', tekst: 'Zie kopje.' }),
      false
    );
    expect(oordeel.status).toBe('Fout');
    expect(oordeel.melding).toBe('Deze sectie heeft geen kop. Maak Kop leeg.');
  });

  it('noemt een item zonder bekende sleutel niet gekoppeld', () => {
    const oordeel = beoordeel(rij({ sleutel: '' }), false);
    expect(oordeel.status).toBe('Niet gekoppeld');
    expect(oordeel.definitie).toBeNull();
  });
});

describe('beoordeelAlle', () => {
  /** "Dupliceren" in Monday kopieert de Sleutel mee. */
  it('keurt beide items met dezelfde sleutel af', () => {
    const uitkomst = beoordeelAlle([rij(), rij({ itemId: '2', tekst: 'Andere tekst.' })]);
    expect(uitkomst.map((u) => u.oordeel.status)).toEqual(['Fout', 'Fout']);
  });

  it('telt twee niet-gekoppelde items niet als dubbel', () => {
    const uitkomst = beoordeelAlle([rij({ sleutel: 'x' }), rij({ itemId: '2', sleutel: 'x' })]);
    expect(uitkomst.map((u) => u.oordeel.status)).toEqual(['Niet gekoppeld', 'Niet gekoppeld']);
  });
});

describe('tekstenUit', () => {
  const label = { merk: 'WorkJoy', term: 'Workshop' };

  it('maakt een verwijderde sectie leeg in plaats van terug te vallen op de oude tekst', () => {
    const teksten = tekstenUit([rij()], label);
    expect(teksten.secties['opdracht.huiswerk'].kind).toBe('tekst');
    expect(teksten.secties['groep.eigen']).toEqual({ kind: 'leeg' });
  });

  it('zet de term in kleine letters, voor midden in een zin', () => {
    expect(tekstenUit([], label)).toMatchObject({ merk: 'WorkJoy', term: 'workshop' });
  });

  it('maakt van een dubbele sleutel een fout in de briefing', () => {
    const teksten = tekstenUit([rij(), rij({ itemId: '2' })], label);
    expect(teksten.secties['opdracht.huiswerk'].kind).toBe('fout');
  });
});

describe('de catalogus', () => {
  it('heeft elke sleutel precies één keer', () => {
    const sleutels = SECTIES.map((s) => s.sleutel);
    expect(new Set(sleutels).size).toBe(sleutels.length);
    expect(sleutels).toHaveLength(Object.keys(standaardTeksten(label()).secties).length);
  });

  /** Anders zou het bord op de eerste dag al rode Fouten tonen. */
  it('keurt elke beginwaarde zelf goed', () => {
    for (const s of SECTIES) {
      const oordeel = beoordeel(
        rij({ sleutel: s.sleutel, kop: s.kop, tekst: s.tekst, naam: s.naam }),
        false
      );
      expect(oordeel.status, s.sleutel).toBe('OK');
    }
  });

  it('heeft geen lege beginwaarde, en geen kop waar geen kop kan', () => {
    for (const s of SECTIES) {
      expect(parseRegels(s.tekst).length, s.sleutel).toBeGreaterThan(0);
      if (!s.heeftKop) {
        expect(s.kop, s.sleutel).toBe('');
      }
    }
  });

  it('legt in de uitleg elke plaatshouder uit die de sectie toestaat', () => {
    const uitleg = uitlegVoor(SECTIES.find((s) => s.sleutel === 'rol.met-acteur')!);
    expect(uitleg).toContain('{acteurs} =');
    expect(uitleg).toContain('{merk} =');
    expect(uitleg).not.toContain('{trainers} =');
  });
});

function label(): { merk: string; term: string } {
  return { merk: 'Incompany Trainer', term: 'Training' };
}
