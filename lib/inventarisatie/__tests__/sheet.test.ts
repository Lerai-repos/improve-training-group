import { describe, expect, it } from 'vitest';

import { leesInventarisatieBron } from '../sheet';

const auth = { accessToken: () => Promise.resolve('t') };

const antwoord = (status: number, body: unknown): typeof fetch => {
  const nep = (): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  return nep;
};

describe('leesInventarisatieBron', () => {
  it('leest de antwoorden van de Opportunity', async () => {
    const lees = await leesInventarisatieBron(
      auth,
      antwoord(200, {
        values: [
          ['Tijdstempel', 'Wat is je naam?', 'Referentie (niet aanpassen)'],
          ['13-10-2026 10:41:23', 'Paula', '42'],
        ],
      })
    );
    expect(lees('42')).toEqual({
      kind: 'ingevuld',
      op: '13-10-2026 10:41:23',
      antwoorden: [{ vraag: 'Wat is je naam?', antwoord: 'Paula' }],
    });
  });

  /** Een storing bij Google is iets anders dan "de klant heeft het niet ingevuld". */
  it('meldt een mislukte lezing als onleesbaar, niet als leeg', async () => {
    const lees = await leesInventarisatieBron(auth, antwoord(403, { error: 'nee' }));
    expect(lees('42')).toEqual({
      kind: 'onleesbaar',
      fout: 'Inventarisatiesheet lezen mislukt (403).',
    });
  });

  it('meldt een sheet zonder Referentie-kolom als onleesbaar', async () => {
    const lees = await leesInventarisatieBron(auth, antwoord(200, { values: [['Tijdstempel']] }));
    expect(lees('42').kind).toBe('onleesbaar');
  });
});
