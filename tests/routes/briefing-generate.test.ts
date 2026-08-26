import { expect, test } from '@playwright/test';
import { SignJWT } from 'jose';

import { TEST_AUTH } from '../../playwright.config';

/**
 * De Genereren-knop over echt HTTP.
 *
 * De beslissingen zelf staan in de unit tests van `lib/briefing` en `lib/sharepoint`; deze
 * suite bestaat voor wat alleen een HTTP-test kan vangen: dat de route zijn bewaking
 * áánroept, en dat er niets gebeurt voor wie er niet bij mag.
 *
 * De server draait met `MONDAY_AGENDA_BOARD_ID=0`, dus geen enkel item hoort erbij en elk
 * verzoek strandt structureel op de bordcontrole. Er wordt dus nooit een document gemaakt en
 * nooit iets naar SharePoint geschreven — wat hier hoe dan ook zou moeten, want de route
 * schrijft naar de échte klantmappen van ITG.
 */

const SYNTHETIC_ITEM = '9900000003';

const CONFIGURED =
  Boolean(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL) &&
  Boolean(process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN) &&
  Boolean(process.env.MONDAY_API_TOKEN);

/** Overslaan is een lokaal gemak, nooit een uitkomst in CI. */
if (!CONFIGURED && process.env.CI) {
  throw new Error(
    'Route tests kunnen niet draaien: zet Redis (UPSTASH_REDIS_REST_URL/_TOKEN of de ' +
      'KV_REST_API_*-aliassen) en MONDAY_API_TOKEN. Ze mogen in CI niet worden overgeslagen.'
  );
}

test.skip(!CONFIGURED, 'heeft Redis + MONDAY_API_TOKEN nodig in de omgeving');

async function token(userId: string): Promise<string> {
  return await new SignJWT({
    dat: { account_id: Number(TEST_AUTH.accountId), user_id: Number(userId) },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(new TextEncoder().encode(TEST_AUTH.clientSecret));
}

const auth = (jwt: string) => ({ Authorization: `Bearer ${jwt}` });
const URL = `/api/briefing/${SYNTHETIC_ITEM}/generate`;

test.describe('authenticatie', () => {
  test('weigert een verzoek zonder token', async ({ request }) => {
    const response = await request.post(URL, { data: {} });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ success: false, error: 'unauthorized' });
  });

  /**
   * Genereren maakt documenten die bij trainers terechtkomen, dus `view` is niet genoeg.
   * Een kijker mag de lijst zien en verder niets.
   */
  test('laat een kijker niet genereren', async ({ request }) => {
    const jwt = await token(TEST_AUTH.viewerId);
    const response = await request.post(URL, { headers: auth(jwt), data: {} });
    expect(response.status()).toBe(403);
  });

  test('weigert een gebruiker zonder enige rechten', async ({ request }) => {
    const jwt = await token(TEST_AUTH.strangerId);
    const response = await request.post(URL, { headers: auth(jwt), data: {} });
    expect(response.status()).toBe(403);
  });
});

test.describe('invoercontrole', () => {
  test('weigert een body die geen JSON is', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.post(URL, {
      headers: { ...auth(jwt), 'Content-Type': 'application/json' },
      data: 'dit is geen json',
    });
    expect(response.status()).toBe(400);
  });

  test('weigert een confirmExisting die geen boolean is', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.post(URL, {
      headers: auth(jwt),
      data: { confirmExisting: 'ja' },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: /true of false/ });
  });

  /**
   * Het plantoken is ondoorzichtig en hoort alleen terug te komen zoals het is uitgedeeld.
   * Een getal of een object is dus geen "ander plan" maar een verkeerd gevormd verzoek.
   */
  test('weigert een planToken dat geen tekst is', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.post(URL, {
      headers: auth(jwt),
      data: { confirmExisting: true, planToken: 42 },
    });
    expect(response.status()).toBe(400);
  });
});

test.describe('bereik', () => {
  /**
   * Zonder deze controle is het item-id uit de URL een vrij te kiezen sleutel, en zou een
   * planner een generatie kunnen starten voor een item van een ander bord.
   */
  test('weigert een item dat niet op het agendabord staat', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.post(URL, { headers: auth(jwt), data: {} });

    expect([404, 502]).toContain(response.status());
    expect(await response.json()).toMatchObject({ success: false });
  });

  /** En met bevestiging al helemaal niet: dát is het pad dat écht wegschrijft. */
  test('weigert het ook met confirmExisting', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.post(URL, {
      headers: auth(jwt),
      data: { confirmExisting: true },
    });

    expect([404, 502]).toContain(response.status());
  });
});
