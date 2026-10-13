import { expect, test } from '@playwright/test';

import { TEST_CRON_SECRET, TEST_WEBHOOK_TOKEN } from '../../playwright.config';

/**
 * De webhook en de nachtelijke ronde van de inventarisatielink over echt HTTP: autorisatie,
 * de challenge, en het negeren van alles wat geen nieuwe Opportunity of ander label is.
 *
 * Bewust géén echt event op het Opportunitybord en geen geautoriseerde cronaanroep: die lezen
 * en schrijven ITG's Opportunities. Wat de sync doet staat in `lib/inventarisatie/__tests__/`.
 */

const WEBHOOK = '/api/webhooks/monday/inventarisatie';
const CRON = '/api/cron/inventarisatie-links';
const OPPORTUNITYBORD = 1279052045;

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

  /** Ons eigen wegschrijven van de link komt ook als kolomwijziging binnen. */
  test('negeert een wijziging in een andere kolom dan Label', async ({ request }) => {
    const response = await request.post(url, {
      data: {
        event: {
          type: 'update_column_value',
          boardId: OPPORTUNITYBORD,
          pulseId: 2,
          columnId: 'itg_inventarisatie',
        },
      },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ genegeerd: 'andere kolom' });
  });

  test('negeert een ander bord', async ({ request }) => {
    const response = await request.post(url, {
      data: { event: { type: 'create_pulse', boardId: 1, pulseId: 2 } },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ genegeerd: 'ander bord' });
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
