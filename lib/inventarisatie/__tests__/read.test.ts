import { describe, expect, it } from 'vitest';

import { leesAlleOpportunities, leesOpportunity, leesWebsites } from '../read';

import type { MondayGraphQLClient } from '@lib/monday/graphql-client';

const OPP = '1279052045';
const LABELS = '5103340139';

interface Kolom {
  id: string;
  type: string;
}

const OPP_KOLOMMEN: Kolom[] = [
  { id: 'label', type: 'status' },
  { id: 'itg_inventarisatie', type: 'link' },
];
const LABEL_KOLOMMEN: Kolom[] = [{ id: 'itg_website', type: 'link' }];

function client(opties: {
  oppKolommen?: Kolom[];
  labelKolommen?: Kolom[];
  rij?: Record<string, unknown>;
  websites?: Record<string, string>;
}): MondayGraphQLClient {
  const rij = opties.rij ?? {
    id: '42',
    board: { id: OPP },
    column_values: [
      { id: 'label', index: 1 },
      { id: 'itg_inventarisatie', url: null, url_text: null },
    ],
  };
  const websites = opties.websites ?? { IT: 'https://www.incompanytrainer.nl' };
  const labelItems = Object.entries(websites).map(([code, website]) => ({
    id: code,
    name: code,
    column_values: [{ id: 'itg_website', text: website, url: website }],
  }));
  const fake = {
    query: (doc: string): Promise<unknown> => {
      if (doc.includes('next_items_page') || doc.includes('items_page(limit: $limit)')) {
        return Promise.resolve({ boards: [{ items_page: { cursor: null, items: [rij] } }] });
      }
      if (doc.includes('items_page')) {
        return Promise.resolve({ boards: [{ items_page: { items: labelItems } }] });
      }
      return Promise.resolve({ items: [rij] });
    },
    getSchema: (ids: string[]) =>
      Promise.resolve(
        ids.map((id) => ({
          id,
          name: id,
          groups: [],
          items_count: 1,
          columns: (id === OPP
            ? (opties.oppKolommen ?? OPP_KOLOMMEN)
            : (opties.labelKolommen ?? LABEL_KOLOMMEN)
          ).map((k) => ({ ...k, title: k.id, settings_str: '{}' })),
        }))
      ),
  };
  // Test double: alleen query en getSchema worden aangeroepen.
  return fake as unknown as MondayGraphQLClient;
}

describe('leesOpportunity', () => {
  it('leest label, URL en zichtbare tekst', async () => {
    const stand = await leesOpportunity(
      client({
        rij: {
          id: '42',
          board: { id: OPP },
          column_values: [
            { id: 'label', index: 9 },
            { id: 'itg_inventarisatie', url: 'https://x.nl/a', url_text: 'klik hier' },
          ],
        },
      }),
      '42'
    );
    expect(stand).toEqual({ itemId: '42', labelIndex: 9, link: 'https://x.nl/a', tekst: 'klik hier' });
  });

  /**
   * Een Label die geen statuskolom meer is geeft geen `index`. Dat als "leeg label" lezen zou
   * de nachtelijke ronde elke link laten wissen.
   */
  it('weigert een Label-cel zonder labelnummer in plaats van hem als leeg te lezen', async () => {
    const rij = {
      id: '42',
      board: { id: OPP },
      column_values: [{ id: 'label' }, { id: 'itg_inventarisatie', url: null, url_text: null }],
    };
    await expect(leesOpportunity(client({ rij }), '42')).rejects.toThrow(/label/);
  });
});

describe('leesAlleOpportunities', () => {
  it('weigert als Label of de linkkolom van type veranderd is', async () => {
    await expect(
      leesAlleOpportunities(
        client({
          oppKolommen: [
            { id: 'label', type: 'text' },
            { id: 'itg_inventarisatie', type: 'link' },
          ],
        })
      )
    ).rejects.toThrow(/label/);
  });
});

describe('leesWebsites', () => {
  it('geeft de website per label', async () => {
    const websites = await leesWebsites(client({}));
    expect(websites.get('IT')).toBe('https://www.incompanytrainer.nl');
  });

  it('weigert als de Website-kolom op het Labels-bord van type veranderd is', async () => {
    await expect(
      leesWebsites(client({ labelKolommen: [{ id: 'itg_website', type: 'text' }] }))
    ).rejects.toThrow(/itg_website/);
  });

  /** Geen enkele bruikbare website is een kapot bord, geen bord zonder websites. */
  it('weigert als geen enkel label een website heeft, in plaats van alle links te wissen', async () => {
    await expect(leesWebsites(client({ websites: { IT: '', WJ: '' } }))).rejects.toThrow(
      /geen enkel label/
    );
  });
});
