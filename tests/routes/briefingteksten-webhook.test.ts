import { expect, test } from '@playwright/test';

import { TEST_WEBHOOK_TOKEN } from '../../playwright.config';

/**
 * De webhook van het bord Briefingteksten over echt HTTP: autorisatie, de challenge, en het
 * negeren van alles wat niet van het bord komt.
 *
 * Bewust géén event dat tot keuren leidt: dat leest en beschrijft het echte bord. Wat het
 * keuren doet staat in `lib/briefingteksten/__tests__/`.
 */

const URL = '/api/webhooks/monday/briefingteksten';

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

  test('negeert een event van een ander bord zonder iets te lezen', async ({ request }) => {
    const response = await request.post(url, {
      data: { event: { type: 'update_column_value', boardId: 123, columnId: 'itg_tekst' } },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ genegeerd: 'ander bord' });
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
