import { expect, test } from '@playwright/test';

import { TEST_WEBHOOK_TOKEN } from '../../playwright.config';

/**
 * De webhook van de knop Eval Rapport over echt HTTP: autorisatie, de challenge, en het
 * negeren van alles wat geen `Eval Status → RUN` is.
 *
 * Bewust géén RUN-event: dat leest het echte agendabord en verstuurt echte mails. Wat de
 * verwerking doet staat in `lib/report/__tests__/knop.test.ts`.
 */

const URL = '/api/webhooks/monday/eval-rapport';

test.describe('authenticatie', () => {
  test('weigert een verzoek zonder token', async ({ request }) => {
    const response = await request.post(URL, { data: { challenge: 'x' } });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  });

  test('weigert een verkeerd token, ook op de challenge', async ({ request }) => {
    const response = await request.post(`${URL}?token=niet-het-goede`, {
      data: { challenge: 'x' },
    });
    expect(response.status()).toBe(401);
  });
});

test.describe('met het juiste token', () => {
  const url = `${URL}?token=${TEST_WEBHOOK_TOKEN}`;

  test('beantwoordt de challenge van Monday', async ({ request }) => {
    const response = await request.post(url, { data: { challenge: 'abc123' } });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'abc123' });
  });

  /** De lusbeveiliging: ons eigen leegmaken van Eval Status komt ook als webhook binnen. */
  test('negeert een andere waarde van Eval Status', async ({ request }) => {
    const response = await request.post(url, {
      data: {
        event: {
          type: 'update_column_value',
          boardId: 1,
          pulseId: 2,
          columnId: 'color_mm0v53mp',
          value: { label: { index: 0, text: 'Geen IE-code' } },
        },
      },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ genegeerd: 'Eval Status is niet RUN' });
  });

  test('negeert een andere kolom', async ({ request }) => {
    const response = await request.post(url, {
      data: { event: { type: 'update_column_value', boardId: 1, pulseId: 2, columnId: 'x' } },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ genegeerd: 'andere kolom' });
  });

  test('weigert een body die geen JSON is', async ({ request }) => {
    // Als Buffer: een string zet Playwright zelf om naar geldige JSON.
    const response = await request.post(url, {
      headers: { 'content-type': 'application/json' },
      data: Buffer.from('{geen json'),
    });
    expect(response.status()).toBe(400);
  });
});
