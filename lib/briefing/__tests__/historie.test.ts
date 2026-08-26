import { describe, expect, it } from 'vitest';

import { clientKey, isRealClient, readHistorie } from '../historie';

import type { MondayGraphQLClient } from '@lib/monday/graphql-client';

/**
 * De historie-tabel leest twee agendaborden en matcht op de `Bedrijf`-mirror. Elk van die
 * drie dingen kan stil misgaan: een bord dat niet meedoet, een klant die in tweeën valt, of
 * een tabel die de verkeerde kant afkapt.
 */

interface Cell {
  id: string;
  text?: string | null;
  display_value?: string | null;
  date?: string | null;
  linked_item_ids?: string[] | null;
}

const COLUMNS = {
  bedrijf: 'lookup_mkszzfvr',
  klanttitel: 'tekst_mkmxrqwc',
  datum: 'datum_1',
  tijden: 'dup__of_workshop',
  contactpersoon: 'tekst8',
  trainer2026: 'board_relation_mkz4y7tb',
  co2026: 'itg_cotrainers',
  trainer2025: 'board_relation_mkz4w78',
};

interface Session {
  id: string;
  bedrijf: string;
  datum: string;
  tijden?: string;
  klanttitel?: string;
  contactpersoon?: string;
  trainers?: string[];
  coTrainers?: string[];
}

const cells = (session: Session, jaar: 2025 | 2026): Cell[] => [
  { id: COLUMNS.bedrijf, display_value: session.bedrijf },
  { id: COLUMNS.klanttitel, text: session.klanttitel ?? 'Feedback' },
  { id: COLUMNS.datum, date: session.datum },
  { id: COLUMNS.tijden, text: session.tijden ?? '09:30-12:30' },
  { id: COLUMNS.contactpersoon, text: session.contactpersoon ?? 'Paula' },
  {
    id: jaar === 2026 ? COLUMNS.trainer2026 : COLUMNS.trainer2025,
    linked_item_ids: session.trainers ?? [],
  },
  ...(jaar === 2026 ? [{ id: COLUMNS.co2026, linked_item_ids: session.coTrainers ?? [] }] : []),
];

/** Een client die per bord een pagina serveert en trainernamen kent. */
const TRAINERS_BOARD = '1661151090';
const MIRROR_SETTINGS = '{"displayed_linked_columns":{"1279052045":["connect_boards31"]}}';

/** Het bordschema dat `readBoard` eist voordat hij één rij leest. */
const schemaFor = (
  boardId: string,
  over: Array<{ id: string; type?: string; settings_str?: string | null }> = []
): Array<{ id: string; title: string; type: string; settings_str: string | null }> => {
  const trainer = boardId === '5087396949' ? COLUMNS.trainer2026 : COLUMNS.trainer2025;
  const base = [
    { id: COLUMNS.bedrijf, type: 'mirror', settings_str: MIRROR_SETTINGS },
    { id: COLUMNS.datum, type: 'date', settings_str: null },
    { id: COLUMNS.klanttitel, type: 'text', settings_str: null },
    { id: COLUMNS.tijden, type: 'text', settings_str: null },
    { id: COLUMNS.contactpersoon, type: 'text', settings_str: null },
    { id: trainer, type: 'board_relation', settings_str: `{"boardIds":[${TRAINERS_BOARD}]}` },
    ...(boardId === '5087396949'
      ? [
          {
            id: COLUMNS.co2026,
            type: 'board_relation',
            settings_str: `{"boardIds":[${TRAINERS_BOARD}]}`,
          },
        ]
      : []),
  ];
  const patched = base.map((c) => {
    const patch = over.find((o) => o.id === c.id);
    return patch === undefined ? c : { ...c, ...patch };
  });
  return patched
    .filter((c) => !over.some((o) => o.id === c.id && o.type === 'REMOVE'))
    .map((c) => ({ ...c, title: c.id }));
};

function client(input: {
  b2026?: Session[];
  b2025?: Session[];
  namen?: Record<string, string>;
  onItems?: (ids: string[]) => void;
  schemaOver?: Array<{ id: string; type?: string; settings_str?: string | null }>;
}): MondayGraphQLClient {
  const query = <T>(document: string, variables?: Record<string, unknown>): Promise<T> => {
    if (document.includes('telefoon_mkn1hbyh')) {
      const ids = ((variables?.ids as string[] | undefined) ?? []).map(String);
      input.onItems?.(ids);
      return Promise.resolve({
        items: ids.map((id) => ({
          id,
          name: input.namen?.[id] ?? `Trainer ${id}`,
          column_values: [{ id: 'telefoon_mkn1hbyh', text: '' }],
        })),
      } as T);
    }
    const board = String((variables?.board as string[] | undefined)?.[0] ?? '');
    const jaar = board === '5087396949' ? 2026 : 2025;
    const sessions = (jaar === 2026 ? input.b2026 : input.b2025) ?? [];
    return Promise.resolve({
      boards: [
        {
          items_page: {
            cursor: null,
            items: sessions.map((s) => ({ id: s.id, column_values: cells(s, jaar) })),
          },
        },
      ],
    } as T);
  };
  const getSchema = (boardIds: string[]): Promise<unknown[]> =>
    Promise.resolve(
      boardIds.map((id) => ({
        id,
        name: `Agenda ${id}`,
        groups: [],
        items_count: 100,
        columns: schemaFor(id, input.schemaOver ?? []),
      }))
    );
  return { query, getSchema } as unknown as MondayGraphQLClient;
}

describe('clientKey', () => {
  /** Een mirror door meerdere koppelingen levert dezelfde naam soms dubbel op. */
  it('ontdubbelt een herhaalde mirror-waarde', () => {
    expect(clientKey('aaff Audit & Assurance, aaff Audit & Assurance')).toBe(
      'aaff audit & assurance'
    );
  });

  it('houdt twee verschillende namen uit elkaar', () => {
    expect(clientKey('CNV, DAS')).toBe('cnv, das');
  });

  it('negeert hoofdletters en witruimte', () => {
    expect(clientKey('  Eleos ')).toBe(clientKey('eleos'));
  });
});

describe('isRealClient', () => {
  it('weigert `maatwerk online`, dat een categorie is en geen klant', () => {
    expect(isRealClient('maatwerk online')).toBe(false);
    expect(isRealClient('Maatwerk Online')).toBe(false);
  });

  it('weigert een lege waarde', () => {
    expect(isRealClient('   ')).toBe(false);
  });

  it('accepteert een echte klant', () => {
    expect(isRealClient('CNV')).toBe(true);
  });
});

describe('readHistorie', () => {
  const base = { bedrijf: 'CNV', excludeItemId: '999' };

  it('haalt sessies van beide agendaborden op, oudste eerst', async () => {
    const rows = await readHistorie(
      client({
        b2026: [{ id: '1', bedrijf: 'CNV', datum: '2026-06-09' }],
        b2025: [{ id: '2', bedrijf: 'CNV', datum: '2025-04-10' }],
      }),
      base
    );
    expect(rows.map((r) => r.datum)).toEqual(['10-04-2025', '09-06-2026']);
  });

  /** De 2025-relatie heeft een ander kolom-id; die vergeten laat de trainer stil wegvallen. */
  it('leest de trainerrelatie van elk bord met zijn eigen kolom-id', async () => {
    const rows = await readHistorie(
      client({
        b2025: [{ id: '2', bedrijf: 'CNV', datum: '2025-04-10', trainers: ['tr1'] }],
        namen: { tr1: 'Karianne Schippers' },
      }),
      base
    );
    expect(rows[0]?.trainer).toBe('Karianne Schippers');
  });

  it('neemt de co-trainers van 2026 mee, achter de lead', async () => {
    const rows = await readHistorie(
      client({
        b2026: [
          { id: '1', bedrijf: 'CNV', datum: '2026-06-09', trainers: ['a'], coTrainers: ['b'] },
        ],
        namen: { a: 'Lead', b: 'Co' },
      }),
      base
    );
    expect(rows[0]?.trainer).toBe('Lead, Co');
  });

  it('laat de training zelf uit haar eigen historie', async () => {
    const rows = await readHistorie(
      client({ b2026: [{ id: '999', bedrijf: 'CNV', datum: '2026-06-09' }] }),
      base
    );
    expect(rows).toEqual([]);
  });

  it('matcht niet op een andere klant', async () => {
    const rows = await readHistorie(
      client({ b2026: [{ id: '1', bedrijf: 'DAS', datum: '2026-06-09' }] }),
      base
    );
    expect(rows).toEqual([]);
  });

  it('geeft niets terug voor `maatwerk online` en leest dan geen enkel bord', async () => {
    let called = false;
    const spy = client({ b2026: [{ id: '1', bedrijf: 'maatwerk online', datum: '2026-06-09' }] });
    const wrapped: MondayGraphQLClient = {
      ...spy,
      query: (document: string, variables?: Record<string, unknown>) => {
        called = true;
        return spy.query(document, variables);
      },
    };
    expect(await readHistorie(wrapped, { ...base, bedrijf: 'maatwerk online' })).toEqual([]);
    expect(called).toBe(false);
  });

  it('laat een sessie zonder datum weg, want die is niet te sorteren', async () => {
    const rows = await readHistorie(
      client({
        b2026: [
          { id: '1', bedrijf: 'CNV', datum: '' },
          { id: '2', bedrijf: 'CNV', datum: '2026-06-09' },
        ],
      }),
      base
    );
    expect(rows).toHaveLength(1);
  });

  /**
   * De belangrijkste: afkappen aan de OUDE kant. Andersom krijgt een trainer die in oktober
   * 2026 voor de groep staat de sessies van april 2025 te zien, en dat ziet er even
   * geloofwaardig uit.
   */
  it('houdt bij een limiet de meest recente sessies over', async () => {
    const rows = await readHistorie(
      client({
        b2026: [
          { id: '1', bedrijf: 'CNV', datum: '2025-01-01' },
          { id: '2', bedrijf: 'CNV', datum: '2025-06-01' },
          { id: '3', bedrijf: 'CNV', datum: '2026-11-01' },
        ],
      }),
      { ...base, limit: 2 }
    );
    expect(rows.map((r) => r.datum)).toEqual(['01-06-2025', '01-11-2026']);
  });

  /** `items(ids:)` kapt stilzwijgend af op 25, dus namen worden in batches opgehaald. */
  it('haalt trainernamen in batches van hoogstens 25 op', async () => {
    const batches: number[] = [];
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      bedrijf: 'CNV',
      datum: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      trainers: [`tr${i}`],
    }));
    await readHistorie(client({ b2026: many, onItems: (ids) => batches.push(ids.length) }), base);
    expect(batches.length).toBeGreaterThan(1);
    expect(Math.max(...batches)).toBeLessThanOrEqual(25);
  });

  /**
   * `Tijden` gaat er letterlijk in. De kolom is vrije tekst met 299 verschillende waarden en
   * er is geen ITG-voorbeeld van deze tabel om naar toe te normaliseren, dus wat wij ervan
   * zouden maken is een gok. De adviseur past het in Word aan.
   */
  it.each(['09.30-16.30 uur', '13:00 tot 17:00', '09:30-12:30', 'n.o.t.k.'])(
    'neemt de tijd letterlijk over: %s',
    async (tijden) => {
      const rows = await readHistorie(
        client({ b2026: [{ id: '1', bedrijf: 'CNV', datum: '2026-06-09', tijden }] }),
        base
      );
      expect(rows[0]?.tijd).toBe(tijden);
    }
  );

  /**
   * De stille faalwijze die dit blok waardeloos maakt: een hernoemde of omgehangen
   * `Bedrijf`-mirror laat niets matchen, en `[]` leest als "gecontroleerd, geen historie".
   * Bij een vaste klant is dat precies verkeerd om.
   */
  it('werpt als de Bedrijf-mirror van het bord verdwenen is', async () => {
    const broken = client({
      b2026: [{ id: '1', bedrijf: 'CNV', datum: '2026-06-09' }],
      schemaOver: [{ id: COLUMNS.bedrijf, type: 'REMOVE' }],
    });
    await expect(readHistorie(broken, base)).rejects.toThrow(/missing column/);
  });

  it('werpt als de mirror door een andere kolom is gaan kijken', async () => {
    const broken = client({
      b2026: [{ id: '1', bedrijf: 'CNV', datum: '2026-06-09' }],
      schemaOver: [
        { id: COLUMNS.bedrijf, settings_str: '{"displayed_linked_columns":{"999":["iets"]}}' },
      ],
    });
    await expect(readHistorie(broken, base)).rejects.toThrow(/settings missing/);
  });

  it('werpt als de trainerrelatie geen relatie meer is', async () => {
    const broken = client({
      b2026: [{ id: '1', bedrijf: 'CNV', datum: '2026-06-09' }],
      schemaOver: [{ id: COLUMNS.trainer2026, type: 'text' }],
    });
    await expect(readHistorie(broken, base)).rejects.toThrow(/expected 'board_relation'/);
  });
});
