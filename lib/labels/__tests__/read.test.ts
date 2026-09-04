import { describe, expect, it } from 'vitest';

import { LABEL_COLUMNS } from '../columns';
import { LABEL_SEED } from '../catalog';
import { mapLabelItems, readLabelRows, readLabels } from '../read';

const C = LABEL_COLUMNS;

interface Cell {
  id: string;
  text?: string | null;
  url?: string | null;
  files?: Array<{ asset: { id: string; name?: string | null; public_url?: string | null } | null }>;
}

/** Een rij zoals Monday hem teruggeeft: alleen de kolommen die gevraagd zijn. */
const item = (name: string, cells: Cell[] = []) => ({
  id: `i-${name}`,
  name,
  column_values: cells,
});

const filled = (name: string, over: Cell[] = []) =>
  item(name, [
    { id: C.volledigeNaam, text: `Naam ${name}` },
    { id: C.kleur, text: '#0A2B58' },
    { id: C.term, text: 'Training' },
    { id: C.rapportterm, text: 'de training' },
    ...over,
  ]);

const allNine = () => LABEL_SEED.map((l) => filled(l.code));

/** Geen cast: `readLabels` vraagt om een concreet antwoordtype. */
const clientFor = (items: ReturnType<typeof item>[]) => ({
  query: async () => ({ boards: [{ items_page: { items } }] }),
});

describe('mapLabelItems', () => {
  it('leest de itemnaam als labelcode', () => {
    const { records } = mapLabelItems([filled('IT')]);
    expect(records[0]?.code).toBe('IT');
    expect(records[0]?.volledigeNaam).toBe('Naam IT');
  });

  /**
   * Een naam met een spatie eromheen is precies het soort onzichtbare bordbewerking dat dit
   * project vaker heeft gezien; hem laten vallen zou als "label ontbreekt" gemeld worden.
   */
  it('trimt de itemnaam voordat hij hem als code beoordeelt', () => {
    const { records, unknown } = mapLabelItems([filled('  SST  ')]);
    expect(unknown).toEqual([]);
    expect(records[0]?.code).toBe('SST');
  });

  it('meldt een rij zonder geldige labelcode apart, in plaats van hem over te slaan', () => {
    const { records, unknown } = mapLabelItems([filled('IT'), filled('YNS')]);
    expect(records).toHaveLength(1);
    expect(unknown).toEqual(['YNS']);
  });

  /**
   * `text` op een link-kolom is de ZICHTBARE tekst en kan "klik hier" zijn. De waarde staat
   * in `url`; dit is de test die het verschil vastlegt.
   */
  it('leest een link uit url, niet uit text', () => {
    const { records } = mapLabelItems([
      filled('IT', [{ id: C.website, text: 'klik hier', url: 'https://www.incompanytrainer.nl' }]),
    ]);
    expect(records[0]?.website).toBe('https://www.incompanytrainer.nl');
  });

  it('geeft een lege link terug als lege string, niet als undefined', () => {
    const { records } = mapLabelItems([filled('IT')]);
    expect(records[0]?.website).toBe('');
    expect(records[0]?.inventarisatieformulier).toBe('');
  });

  it('leest de eerste afbeelding uit een bestandskolom', () => {
    const { records } = mapLabelItems([
      filled('IT', [
        {
          id: C.voorblad,
          files: [{ asset: { id: 'a1', name: 'voor.png', public_url: 'https://x/voor.png' } }],
        },
      ]),
    ]);
    expect(records[0]?.voorblad).toEqual({
      id: 'a1',
      name: 'voor.png',
      publicUrl: 'https://x/voor.png',
    });
  });

  /**
   * Een bestand zonder bruikbare URL moet `null` worden en geen lege string, anders wordt het
   * verderop een download naar `""` — een mislukking op een plek die er niets van weet.
   */
  it('behandelt een bestand zonder public_url als afwezig', () => {
    const { records } = mapLabelItems([
      filled('IT', [{ id: C.logo, files: [{ asset: { id: 'a1', public_url: '' } }] }]),
    ]);
    expect(records[0]?.logo).toBeNull();
  });

  it('behandelt een lege bestandskolom als afwezig', () => {
    const { records } = mapLabelItems([filled('IT', [{ id: C.logo, files: [] }])]);
    expect(records[0]?.logo).toBeNull();
  });

  /**
   * Uploaden VOEGT TOE aan een bestandskolom. Wie een nieuw voorblad neerzet zonder het oude
   * weg te halen heeft er twee, en `files[0]` zou dan het oude blijven renderen — met het
   * nieuwe bestand zichtbaar in de kolom als bewijs dat het vervangen had moeten zijn.
   */
  it('weigert een bestandskolom met twee bruikbare bestanden', () => {
    const { records, ambiguous } = mapLabelItems([
      filled('IT', [
        {
          id: C.voorblad,
          files: [
            { asset: { id: 'a1', name: 'oud.png', public_url: 'https://x/oud.png' } },
            { asset: { id: 'a2', name: 'nieuw.png', public_url: 'https://x/nieuw.png' } },
          ],
        },
      ]),
    ]);
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]).toContain('Voorblad');
    expect(ambiguous[0]).toContain('oud.png');
    expect(ambiguous[0]).toContain('nieuw.png');
    // En zeker niet stilletjes de eerste pakken.
    expect(records[0]?.voorblad).toBeNull();
  });

  /** Eén bruikbaar bestand naast een onbruikbaar is niet dubbelzinnig, maar gewoon dat ene. */
  it('telt een bestand zonder public_url niet mee als tweede', () => {
    const { records, ambiguous } = mapLabelItems([
      filled('IT', [
        {
          id: C.logo,
          files: [
            { asset: { id: 'a1', name: 'kapot.png', public_url: '' } },
            { asset: { id: 'a2', name: 'goed.png', public_url: 'https://x/goed.png' } },
          ],
        },
      ]),
    ]);
    expect(ambiguous).toEqual([]);
    expect(records[0]?.logo?.name).toBe('goed.png');
  });

  it('noemt het bestand bij zijn id als het geen naam heeft', () => {
    const { ambiguous } = mapLabelItems([
      filled('IT', [
        {
          id: C.achterblad,
          files: [
            { asset: { id: 'a1', public_url: 'https://x/1.png' } },
            { asset: { id: 'a2', public_url: 'https://x/2.png' } },
          ],
        },
      ]),
    ]);
    expect(ambiguous[0]).toContain('a1');
    expect(ambiguous[0]).toContain('a2');
  });
});

describe('readLabels', () => {
  it('geeft de negen labels terug, op code', async () => {
    const labels = await readLabels(clientFor(allNine()), 'b1');
    expect(labels.size).toBe(9);
    expect(labels.get('FT')?.volledigeNaam).toBe('Naam FT');
  });

  it('werpt als het bord niet bestaat', async () => {
    const empty = { query: async () => ({ boards: [] }) };
    await expect(readLabels(empty, 'b1')).rejects.toThrow('niet gevonden');
  });

  /**
   * Fail-closed is hier het hele punt: een ontbrekend label levert anders een rapport op in
   * de standaardkleur, en dat ziet er volkomen normaal uit voor wie het merk niet kent.
   */
  it('werpt als een label ontbreekt, en noemt welk', async () => {
    const rows = allNine().filter((i) => i.name !== 'CP');
    await expect(readLabels(clientFor(rows), 'b1')).rejects.toThrow('CP');
  });

  it('werpt op een dubbele rij', async () => {
    await expect(readLabels(clientFor([...allNine(), filled('IT')]), 'b1')).rejects.toThrow(
      'meerdere keren'
    );
  });

  it('werpt op een kleur die geen hex is, en noemt de waarde', async () => {
    const rows = allNine();
    rows[0] = filled('IT', []);
    rows[0].column_values = rows[0].column_values.map((c) =>
      c.id === C.kleur ? { ...c, text: 'donkerblauw' } : c
    );
    await expect(readLabels(clientFor(rows), 'b1')).rejects.toThrow('donkerblauw');
  });

  it('noemt een rij met een onbekende naam in de foutmelding', async () => {
    await expect(readLabels(clientFor([...allNine(), filled('TMT')]), 'b1')).rejects.toThrow('TMT');
  });

  /** Alle problemen in één melding, zodat een reparatieronde er niet drie kost. */
  it('somt meerdere problemen tegelijk op', async () => {
    const rows = allNine().filter((i) => i.name !== 'CP' && i.name !== 'FT');
    const message = await readLabels(clientFor(rows), 'b1').catch((e: Error) => e.message);
    expect(message).toContain('CP');
    expect(message).toContain('FT');
  });

  /** Lege briefingvelden mogen het rapport niet blokkeren — zo staat FT vandaag op het bord. */
  it('accepteert lege website- en formuliervelden', async () => {
    const labels = await readLabels(clientFor(allNine()), 'b1');
    expect(labels.get('FT')?.website).toBe('');
  });

  it('werpt op een bestandskolom met twee bestanden, en noemt de kolom', async () => {
    const rows = allNine();
    rows[0] = filled('IT', [
      {
        id: C.logo,
        files: [
          { asset: { id: 'a1', name: 'oud.png', public_url: 'https://x/1' } },
          { asset: { id: 'a2', name: 'nieuw.png', public_url: 'https://x/2' } },
        ],
      },
    ]);
    await expect(readLabels(clientFor(rows), 'b1')).rejects.toThrow('Logo');
  });
});

/**
 * De diagnostische lezer bestaat omdat twee lezers tegengestelde eisen hebben: de rapportmotor
 * moet een onvolledig bord weigeren, de dagelijkse controle moet het juist kunnen lezen — een
 * ontbrekende rij is daar geen storing maar de melding zelf.
 */
describe('readLabelRows', () => {
  it('geeft een ontbrekende rij terug als probleem in plaats van te werpen', async () => {
    const rows = allNine().filter((r) => r.name !== 'CP');
    const { records, problems } = await readLabelRows(clientFor(rows), 'b1');
    expect(records).toHaveLength(8);
    expect(problems).toContainEqual({ kind: 'missing_label', code: 'CP' });
  });

  it('geeft een leeg verplicht veld terug als probleem in plaats van te werpen', async () => {
    // Een rij waarvan de Kleur-cel leeg is; de rest staat er gewoon.
    const leegITem = item('IT', [
      { id: C.volledigeNaam, text: 'Naam IT' },
      { id: C.kleur, text: '' },
      { id: C.term, text: 'Training' },
      { id: C.rapportterm, text: 'de training' },
    ]);
    const rows = [leegITem, ...allNine().filter((r) => r.name !== 'IT')];

    const { records, problems } = await readLabelRows(clientFor(rows), 'b1');

    expect(records).toHaveLength(9);
    expect(problems).toContainEqual({ kind: 'empty_field', code: 'IT', field: 'Kleur' });
  });

  /**
   * Structurele problemen blijven wél fataal: bij twee rijen "IT" is niet te bepalen welke
   * configuratie geldt, en dat kan geen enkele melding uitdrukken.
   */
  it('werpt nog steeds bij een dubbele rij', async () => {
    await expect(readLabelRows(clientFor([...allNine(), filled('IT')]), 'b1')).rejects.toThrow(
      /niet eenduidig/
    );
  });

  it('werpt nog steeds als het bord niet bestaat', async () => {
    const empty = { query: async () => ({ boards: [] }) };
    await expect(readLabelRows(empty, 'b1')).rejects.toThrow('niet gevonden');
  });

  it('laat de strikte lezer ongemoeid: die weigert een ontbrekende rij nog steeds', async () => {
    const rows = allNine().filter((r) => r.name !== 'CP');
    await expect(readLabels(clientFor(rows), 'b1')).rejects.toThrow('CP');
  });
});
