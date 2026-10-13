import { describe, expect, it } from 'vitest';

import { TEKST_COLUMNS } from '../columns';
import { readMerk, readTekstRijen } from '../read';
import { statusWijzigingen, synchroniseerStatussen } from '../status';

import type { BoardMeta } from '@lib/monday/graphql-client';
import type { TekstRij } from '../beoordeel';
import type { TekstenReader, TekstenWriter } from '../index';

const rij = (overrides: Partial<TekstRij> = {}): TekstRij => ({
  itemId: '1',
  naam: 'Huiswerkopdracht',
  sleutel: 'opdracht.huiswerk',
  kop: 'Huiswerkopdracht',
  tekst: 'Doe het huiswerk.',
  status: 'OK',
  melding: '',
  ...overrides,
});

describe('statusWijzigingen', () => {
  /** Anders schrijft elke webhook het hele bord opnieuw weg. */
  it('laat een item met de juiste Status met rust', () => {
    expect(statusWijzigingen([rij()])).toEqual([]);
  });

  it('zet een fout op Fout, met de reden erbij', () => {
    expect(statusWijzigingen([rij({ tekst: 'Namens {mrek}.' })])).toEqual([
      {
        itemId: '1',
        naam: 'Huiswerkopdracht',
        status: 'Fout',
        melding: 'Onbekende plaatshouder {mrek}. Hier kan: {merk}, {term}.',
      },
    ]);
  });

  it('haalt de melding weg zodra het weer klopt', () => {
    expect(statusWijzigingen([rij({ status: 'Fout', melding: 'oud' })])).toEqual([
      { itemId: '1', naam: 'Huiswerkopdracht', status: 'OK', melding: '' },
    ]);
  });
});

const SCHEMA: BoardMeta = {
  id: '77',
  name: 'Briefingteksten',
  columns: [
    { id: TEKST_COLUMNS.kop, type: 'text', title: 'Kop', settings_str: null },
    { id: TEKST_COLUMNS.tekst, type: 'long_text', title: 'Tekst', settings_str: null },
    { id: TEKST_COLUMNS.status, type: 'status', title: 'Status', settings_str: null },
    { id: TEKST_COLUMNS.melding, type: 'text', title: 'Melding', settings_str: null },
    { id: TEKST_COLUMNS.sleutel, type: 'text', title: 'Sleutel', settings_str: null },
  ],
  groups: [],
  items_count: 1,
};

function reader(items: unknown[], opties: { cursor?: string; schema?: BoardMeta } = {}) {
  const queries: Array<Record<string, unknown> | undefined> = [];
  const client: TekstenReader = {
    getSchema: async () => [opties.schema ?? SCHEMA],
    query: async <T,>(_document: string, variables?: Record<string, unknown>): Promise<T> => {
      queries.push(variables);
      // Test double: de echte client parst JSON en belooft dezelfde vorm.
      return { boards: [{ items_page: { cursor: opties.cursor ?? null, items } }] } as T;
    },
  };
  return { client, queries };
}

const item = (id: string, waarden: Record<string, string>) => ({
  id,
  name: `item ${id}`,
  column_values: Object.entries(waarden).map(([kolom, text]) => ({ id: kolom, text })),
});

describe('readTekstRijen', () => {
  it('leest de kolommen van elk item', async () => {
    const { client } = reader([
      item('5', {
        [TEKST_COLUMNS.sleutel]: ' groep.eigen ',
        [TEKST_COLUMNS.kop]: 'Kop',
        [TEKST_COLUMNS.tekst]: 'Tekst',
        [TEKST_COLUMNS.status]: 'OK',
      }),
    ]);
    expect(await readTekstRijen(client, '77')).toEqual([
      {
        itemId: '5',
        naam: 'item 5',
        sleutel: 'groep.eigen',
        kop: 'Kop',
        tekst: 'Tekst',
        status: 'OK',
        melding: '',
      },
    ]);
  });

  /** Een ongelezen item telt als verwijderd, en dan verdwijnt een sectie stil. */
  it('weigert een bord met meer items dan één pagina', async () => {
    const { client } = reader([], { cursor: 'volgende' });
    await expect(readTekstRijen(client, '77')).rejects.toThrow(/meer dan 200 items/);
  });

  it('weigert een bord zonder de kolom Tekst', async () => {
    const { client } = reader([], {
      schema: { ...SCHEMA, columns: SCHEMA.columns.filter((c) => c.id !== TEKST_COLUMNS.tekst) },
    });
    await expect(readTekstRijen(client, '77')).rejects.toThrow(/missing column itg_tekst/);
  });
});

describe('readMerk', () => {
  const labelItem = (naam: string, merk: string, term: string) => ({
    id: naam,
    name: naam,
    column_values: [
      { id: 'itg_volledige_naam', text: merk },
      { id: 'itg_term', text: term },
    ],
  });

  it('leest de naam en term van het label', async () => {
    const { client } = reader([labelItem('IT', 'Incompany Trainer', 'Training')]);
    expect(await readMerk(client, '9', 'it')).toEqual({
      merk: 'Incompany Trainer',
      term: 'Training',
    });
  });

  /** `WJ` op de agenda en een rij `WorkJoy` op het bord zijn hetzelfde label, en andersom. */
  it('vindt de rij via de schrijfwijze, in beide richtingen', async () => {
    const { client } = reader([labelItem('WorkJoy', 'WorkJoy', 'Workshop')]);
    expect(await readMerk(client, '9', 'WJ')).toEqual({ merk: 'WorkJoy', term: 'Workshop' });
    const { client: andersom } = reader([labelItem('WJ', 'WorkJoy', 'Workshop')]);
    expect(await readMerk(andersom, '9', 'workjoy')).toEqual({ merk: 'WorkJoy', term: 'Workshop' });
  });

  it('weigert een label zonder rij of met een lege term', async () => {
    const { client } = reader([labelItem('IT', 'Incompany Trainer', '')]);
    await expect(readMerk(client, '9', 'WJ')).rejects.toThrow(/geen rij voor WJ/);
    await expect(readMerk(client, '9', 'IT')).rejects.toThrow(/Term is leeg|is Term leeg/);
  });
});

describe('synchroniseerStatussen', () => {
  it('schrijft alleen wat afwijkt, met Status op naam', async () => {
    const { client } = reader([
      item('1', {
        [TEKST_COLUMNS.sleutel]: 'groep.eigen',
        [TEKST_COLUMNS.kop]: 'Kop',
        [TEKST_COLUMNS.tekst]: 'Goed.',
        [TEKST_COLUMNS.status]: 'OK',
      }),
      item('2', {
        [TEKST_COLUMNS.sleutel]: 'groep.samen',
        [TEKST_COLUMNS.tekst]: '',
        [TEKST_COLUMNS.status]: 'OK',
      }),
    ]);
    const writes: Array<Record<string, unknown> | undefined> = [];
    const writer: TekstenWriter = {
      mutate: async <T,>(_document: string, variables?: Record<string, unknown>): Promise<T> => {
        writes.push(variables);
        // Test double: het antwoord wordt niet gelezen.
        return {} as T;
      },
    };

    const gewijzigd = await synchroniseerStatussen(client, writer, '77');

    expect(gewijzigd.map((w) => w.itemId)).toEqual(['2']);
    expect(writes).toEqual([
      {
        board: '77',
        item: '2',
        values: JSON.stringify({
          [TEKST_COLUMNS.status]: { label: 'Leeg' },
          [TEKST_COLUMNS.melding]: 'Tekst is leeg, dus deze sectie staat niet in de briefing.',
        }),
      },
    ]);
  });
});
