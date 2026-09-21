import { expect, test } from '@playwright/test';

import { TEST_CRON_SECRET } from '../../playwright.config';

/**
 * De overname-cron over echt HTTP: alleen de autorisatiebedrading.
 *
 * Wat de job doet — welke cel gevuld wordt, wat een conflict is — staat in
 * `lib/overname/__tests__/`. Wat alleen hier te bewijzen is, is dat de route bestaat op het
 * pad dat `vercel.json` inplant en dat hij zijn bearer toetst vóór hij iets leest.
 *
 * Bewust GEEN geautoriseerde aanroep: die ontdekt de echte agendaborden en zou zonder
 * `?dryRun=1` in ITG's agenda schrijven. Een droogloop leest wel alles, en dat zijn tientallen
 * seconden Monday voor een test die niets meer bewijst dan de unit-tests al doen.
 */

const URL = '/api/cron/opportunity-overname';

const auth = (secret: string) => ({ Authorization: `Bearer ${secret}` });

test.describe('authenticatie', () => {
  test('weigert een verzoek zonder token', async ({ request }) => {
    const response = await request.get(URL);
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  });

  test('weigert een verkeerd token', async ({ request }) => {
    const response = await request.get(URL, { headers: auth('niet-het-goede-secret') });
    expect(response.status()).toBe(401);
  });

  test('weigert een token zonder Bearer-prefix', async ({ request }) => {
    const response = await request.get(URL, { headers: { Authorization: TEST_CRON_SECRET } });
    expect(response.status()).toBe(401);
  });

  test('doet niets voor een afgewezen aanroeper', async ({ request }) => {
    const started = Date.now();
    await request.get(URL);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
