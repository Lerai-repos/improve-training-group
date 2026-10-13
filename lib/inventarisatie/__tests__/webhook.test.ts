import { describe, expect, it } from 'vitest';

import { parseInventarisatieWebhook, verwerkInventarisatieWebhook } from '../webhook';

const OPP = 1279052045;

describe('parseInventarisatieWebhook', () => {
  it('beantwoordt de challenge', () => {
    expect(parseInventarisatieWebhook({ challenge: 'abc' })).toEqual({
      kind: 'challenge',
      challenge: 'abc',
    });
  });

  it('zet een nieuwe Opportunity in gang', () => {
    expect(
      parseInventarisatieWebhook({ event: { type: 'create_pulse', boardId: OPP, pulseId: 42 } })
    ).toEqual({ kind: 'sync', itemId: '42' });
  });

  it('zet een ander label in gang', () => {
    expect(
      parseInventarisatieWebhook({
        event: { type: 'update_column_value', boardId: OPP, pulseId: 42, columnId: 'label' },
      })
    ).toEqual({ kind: 'sync', itemId: '42' });
  });

  /** Ons eigen wegschrijven van de link mag niets in gang zetten. */
  it('negeert een wijziging in een andere kolom, ook in de linkkolom', () => {
    expect(
      parseInventarisatieWebhook({
        event: {
          type: 'update_column_value',
          boardId: OPP,
          pulseId: 42,
          columnId: 'itg_inventarisatie',
        },
      })
    ).toEqual({ kind: 'negeren', reden: 'andere kolom' });
  });

  it('negeert een ander bord', () => {
    expect(
      parseInventarisatieWebhook({ event: { type: 'create_pulse', boardId: 1, pulseId: 42 } })
    ).toEqual({ kind: 'negeren', reden: 'ander bord' });
  });
});

describe('verwerkInventarisatieWebhook', () => {
  it('geeft 500 als de sync mislukt, zodat Monday het opnieuw aflevert', async () => {
    const antwoord = await verwerkInventarisatieWebhook({ kind: 'sync', itemId: '42' }, () =>
      Promise.reject(new Error('Monday traag'))
    );
    expect(antwoord).toEqual({ status: 500, body: { itemId: '42', error: 'Monday traag' } });
  });

  it('meldt wat hij met de link deed', async () => {
    const antwoord = await verwerkInventarisatieWebhook({ kind: 'sync', itemId: '42' }, () =>
      Promise.resolve('geschreven')
    );
    expect(antwoord).toEqual({ status: 200, body: { itemId: '42', link: 'geschreven' } });
  });
});
