import { describe, expect, it } from 'vitest';

import { TEKST_COLUMNS } from '../columns';
import { parseTekstWebhook, verwerkTekstWebhook } from '../webhook';

const BORD = '77';
const event = (e: Record<string, unknown>) => ({ event: { boardId: 77, pulseId: 1, ...e } });

describe('parseTekstWebhook', () => {
  it('beantwoordt de challenge', () => {
    expect(parseTekstWebhook({ challenge: 'abc' }, BORD)).toEqual({
      kind: 'challenge',
      challenge: 'abc',
    });
  });

  it('keurt opnieuw na een wijziging in Kop, Tekst of Sleutel', () => {
    for (const kolom of [TEKST_COLUMNS.kop, TEKST_COLUMNS.tekst, TEKST_COLUMNS.sleutel]) {
      expect(
        parseTekstWebhook(event({ type: 'update_column_value', columnId: kolom }), BORD)
      ).toEqual({ kind: 'keuren' });
    }
  });

  /** De lusbeveiliging: ons eigen wegschrijven komt ook als webhook binnen. */
  it('negeert een wijziging in Status of Melding', () => {
    for (const kolom of [TEKST_COLUMNS.status, TEKST_COLUMNS.melding, TEKST_COLUMNS.uitleg]) {
      expect(
        parseTekstWebhook(event({ type: 'update_column_value', columnId: kolom }), BORD).kind
      ).toBe('negeren');
    }
  });

  /** Een gedupliceerd item heeft dezelfde Sleutel, en dat hoort meteen rood te worden. */
  it('keurt opnieuw bij een nieuw item', () => {
    expect(parseTekstWebhook(event({ type: 'create_pulse' }), BORD)).toEqual({ kind: 'keuren' });
  });

  it('negeert een event van een ander bord', () => {
    expect(
      parseTekstWebhook(event({ boardId: 5, type: 'create_pulse' }), BORD)
    ).toMatchObject({ kind: 'negeren', reden: 'ander bord' });
  });

  it('negeert rommel', () => {
    expect(parseTekstWebhook(null, BORD).kind).toBe('negeren');
    expect(parseTekstWebhook({ event: {} }, BORD).kind).toBe('negeren');
  });
});

describe('verwerkTekstWebhook', () => {
  it('keurt en zegt hoeveel items er veranderden', async () => {
    const antwoord = await verwerkTekstWebhook({ kind: 'keuren' }, async () => [
      { itemId: '1', naam: 'x', status: 'OK', melding: '' },
    ]);
    expect(antwoord).toEqual({ status: 200, body: { bijgewerkt: 1 } });
  });

  it('keurt niet bij een genegeerd event', async () => {
    let gekeurd = false;
    const antwoord = await verwerkTekstWebhook({ kind: 'negeren', reden: 'x' }, async () => {
      gekeurd = true;
      return [];
    });
    expect(gekeurd).toBe(false);
    expect(antwoord.status).toBe(200);
  });

  /** 500 laat Monday het event opnieuw afleveren. */
  it('geeft 500 als het keuren mislukt', async () => {
    const antwoord = await verwerkTekstWebhook({ kind: 'keuren' }, async () => {
      throw new Error('Monday plat');
    });
    expect(antwoord).toEqual({ status: 500, body: { error: 'Monday plat' } });
  });
});
