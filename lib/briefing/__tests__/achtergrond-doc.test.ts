import { describe, expect, it } from 'vitest';

import {
  blokkenNaarAlineas,
  DOC_BLOCK_PAGE,
  docObjectId,
  leesAchtergrondDoc,
} from '../achtergrond-doc';

/** Een blok zoals `docs { blocks { type content } }` het teruggeeft. */
function blok(type: string, ...inserts: Array<string | { insert: unknown; attributes?: object }>) {
  return {
    type,
    content: JSON.stringify({
      alignment: 'left',
      direction: 'ltr',
      deltaFormat: inserts.map((i) => (typeof i === 'string' ? { insert: i } : i)),
    }),
  };
}

describe('docObjectId', () => {
  it('leest het object-id uit de celwaarde van een Doc-kolom', () => {
    const value = JSON.stringify({
      files: [{ name: 'Untitled', fileType: 'MONDAY_DOC', objectId: 5106912446 }],
    });
    expect(docObjectId(value)).toBe('5106912446');
  });

  it('geeft null bij een lege cel', () => {
    expect(docObjectId(null)).toBeNull();
    expect(docObjectId('')).toBeNull();
    expect(docObjectId(JSON.stringify({ files: [] }))).toBeNull();
  });

  /** Een vorm die we niet kennen is drift, geen leeg document. */
  it('weigert een celwaarde in een onbekende vorm', () => {
    expect(() => docObjectId('{"bestand":1}')).toThrow(/Doc-kolom/);
    expect(() => docObjectId('geen json')).toThrow(/Doc-kolom/);
  });
});

describe('blokkenNaarAlineas', () => {
  it('maakt van elke titel een kop en van tekst een alinea', () => {
    expect(
      blokkenNaarAlineas([
        blok('medium title', 'De aanleiding'),
        blok('normal text', 'Het team groeit.'),
        blok('large title', 'Wat we zien'),
        blok('small title', 'Kleiner kopje'),
      ])
    ).toEqual([
      { tekst: 'De aanleiding', kop: true, niveau: 2 },
      { tekst: 'Het team groeit.', kop: false, niveau: 0 },
      { tekst: 'Wat we zien', kop: true, niveau: 1 },
      { tekst: 'Kleiner kopje', kop: true, niveau: 3 },
    ]);
  });

  it('plakt de stukjes van een alinea aan elkaar, ook als een deel vet is', () => {
    expect(
      blokkenNaarAlineas([
        blok('normal text', 'Een ', { insert: 'vette', attributes: { bold: true } }, ' zin.'),
      ])
    ).toEqual([{ tekst: 'Een vette zin.', kop: false, niveau: 0 }]);
  });

  it('zet een opsomming als bullet en een genummerde lijst met nummers', () => {
    expect(
      blokkenNaarAlineas([
        blok('bulleted list', 'eerste'),
        blok('check list', 'afvinken'),
        blok('numbered list', 'een'),
        blok('numbered list', 'twee'),
        blok('normal text', 'tussendoor'),
        blok('numbered list', 'opnieuw'),
      ])
    ).toEqual([
      { tekst: '• eerste', kop: false, niveau: 0 },
      { tekst: '• afvinken', kop: false, niveau: 0 },
      { tekst: '1. een', kop: false, niveau: 0 },
      { tekst: '2. twee', kop: false, niveau: 0 },
      { tekst: 'tussendoor', kop: false, niveau: 0 },
      { tekst: '1. opnieuw', kop: false, niveau: 0 },
    ]);
  });

  it('slaat lege blokken, scheidingslijnen en plaatjes over', () => {
    expect(
      blokkenNaarAlineas([
        blok('normal text', '   '),
        { type: 'divider', content: '{}' },
        { type: 'image', content: JSON.stringify({ url: 'x' }) },
        blok('normal text', { insert: { mention: 1 } }),
        { type: 'normal text', content: null },
        blok('normal text', 'blijft'),
      ])
    ).toEqual([{ tekst: 'blijft', kop: false, niveau: 0 }]);
  });

  it('maakt van een zachte regelafbreking in een blok een nieuwe alinea', () => {
    expect(blokkenNaarAlineas([blok('normal text', 'regel een\nregel twee\n')])).toEqual([
      { tekst: 'regel een', kop: false, niveau: 0 },
      { tekst: 'regel twee', kop: false, niveau: 0 },
    ]);
  });
});

describe('leesAchtergrondDoc', () => {
  /** Monday geeft zonder `limit` stilzwijgend maar 25 blokken; gemeten 29-Oct-2026. */
  it('haalt alle pagina’s op tot een pagina niet vol is', async () => {
    const totaal = DOC_BLOCK_PAGE + 3;
    const gevraagd: number[] = [];
    const client = {
      query: <T>(_doc: string, vars?: Record<string, unknown>): Promise<T> => {
        const page = Number(vars?.page);
        gevraagd.push(page);
        const start = (page - 1) * DOC_BLOCK_PAGE;
        const blocks = Array.from(
          { length: Math.max(0, Math.min(DOC_BLOCK_PAGE, totaal - start)) },
          (_, i) => blok('normal text', `alinea ${start + i}`)
        );
        return Promise.resolve({ docs: [{ id: '1', blocks }] } as T);
      },
    };
    const alineas = await leesAchtergrondDoc(client, '42');
    expect(alineas).toHaveLength(totaal);
    expect(alineas.at(-1)?.tekst).toBe(`alinea ${totaal - 1}`);
    expect(gevraagd).toEqual([1, 2]);
  });

  /** De docs-API gaf op 29-Oct-2026 bij 4 van 169 leesacties een losse `Internal server error`. */
  it('probeert een losse serverfout opnieuw', async () => {
    let pogingen = 0;
    const client = {
      query: <T>(): Promise<T> => {
        pogingen += 1;
        if (pogingen === 1) {
          return Promise.reject(new Error('Monday GraphQL error: Internal server error'));
        }
        return Promise.resolve({
          docs: [{ id: '1', blocks: [blok('normal text', 'tekst')] }],
        } as T);
      },
    };
    expect(await leesAchtergrondDoc(client, '42', { wachtMs: 0 })).toEqual([
      { tekst: 'tekst', kop: false, niveau: 0 },
    ]);
    expect(pogingen).toBe(2);
  });

  it('geeft een andere fout meteen door', async () => {
    let pogingen = 0;
    const client = {
      query: <T>(): Promise<T> => {
        pogingen += 1;
        return Promise.reject(new Error('Monday GraphQL error: Permission denied'));
      },
    };
    await expect(leesAchtergrondDoc(client, '42', { wachtMs: 0 })).rejects.toThrow(/Permission/);
    expect(pogingen).toBe(1);
  });

  /** Een cel die naar een document wijst dat niet terugkomt is drift, geen lege tekst. */
  it('weigert als het document niet bestaat', async () => {
    const client = {
      query: <T>(): Promise<T> => Promise.resolve({ docs: [] } as T),
    };
    await expect(leesAchtergrondDoc(client, '42')).rejects.toThrow(/42/);
  });
});
