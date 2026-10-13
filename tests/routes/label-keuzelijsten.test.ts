import { expect, test } from '@playwright/test';

import { TEST_CRON_SECRET, TEST_WEBHOOK_TOKEN } from '../../playwright.config';

/**
 * De webhook op het Labels-bord en de nachtelijke ronde voor de keuzelijsten, over echt HTTP:
 * autorisatie, de challenge, en het negeren van wat niet van het Labels-bord komt.
 *
 * Bewust géén echt event en geen geautoriseerde cronaanroep: die schrijven in de keuzelijsten van
 * ITG's Opportunity en agenda. Wat de sync doet staat in `lib/labels/__tests__/keuzelijst.test.ts`.
 */

const WEBHOOK = '/api/webhooks/monday/labels';
const CRON = '/api/cron/label-keuzelijsten';

test.describe('webhook: authenticatie', () => {
  test('weigert een verzoek zonder token', async ({ request }) => {
    const response = await request.post(WEBHOOK, { data: { challenge: 'x' } });
    expect(response.status()).toBe(401);
  });

  test('weigert een verkeerd token, ook op de challenge', async ({ request }) => {
    const response = await request.post(`${WEBHOOK}?token=niet-het-goede`, {
      data: { challenge: 'x' },
    });
    expect(response.status()).toBe(401);
  });
});

test.describe('webhook: met het juiste token', () => {
  const url = `${WEBHOOK}?token=${TEST_WEBHOOK_TOKEN}`;

  test('beantwoordt de challenge van Monday', async ({ request }) => {
    const response = await request.post(url, { data: { challenge: 'abc123' } });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ challenge: 'abc123' });
  });

  test('negeert een ander bord', async ({ request }) => {
    const response = await request.post(url, {
      data: { event: { type: 'create_pulse', boardId: 1, pulseId: 2 } },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true, genegeerd: 'ander bord: 1' });
  });

  test('weigert een body die geen JSON is', async ({ request }) => {
    const response = await request.post(url, {
      headers: { 'content-type': 'application/json' },
      data: Buffer.from('{geen json'),
    });
    expect(response.status()).toBe(400);
  });
});

test.describe('nachtelijke ronde: authenticatie', () => {
  test('weigert een verzoek zonder token', async ({ request }) => {
    const response = await request.get(CRON);
    expect(response.status()).toBe(401);
  });

  test('weigert een token zonder Bearer-prefix', async ({ request }) => {
    const response = await request.get(CRON, { headers: { Authorization: TEST_CRON_SECRET } });
    expect(response.status()).toBe(401);
  });
});
