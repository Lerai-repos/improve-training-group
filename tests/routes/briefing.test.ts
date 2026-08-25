import { expect, test } from '@playwright/test';
import { SignJWT } from 'jose';

import { TEST_AUTH } from '../../playwright.config';

/**
 * De briefing-API over echt HTTP.
 *
 * De beslissingen zelf staan in de unit tests van `lib/briefing`; deze suite bestaat voor wat
 * alleen een HTTP-test kan vangen: dat de route ze ook echt aanroept. Een route die `guard`
 * vergat, of die 200 teruggaf met een body die niemand had gecontroleerd, komt door elke unit
 * test in deze repo heen.
 *
 * De server wordt door `playwright.config.ts` gestart met een test-clientsecret, dus deze
 * tokens verifiëren écht en niet tegen een stub. Alles gebruikt een verzonnen item-id, en de
 * server draait met `MONDAY_AGENDA_BOARD_ID=0` — daar kan geen enkel item op staan, dus de
 * schrijfroute strandt structureel op de bordcontrole en er wordt nooit iets naar Redis of
 * Monday geschreven.
 */

const SYNTHETIC_ITEM = '9900000002';

const CONFIGURED =
  Boolean(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL) &&
  Boolean(process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN) &&
  Boolean(process.env.MONDAY_API_TOKEN);

/**
 * Overslaan is een lokaal gemak, nooit een uitkomst in CI. Een groene pijplijn die hier niets
 * van draaide zou beweren dat de toegangscontrole klopt terwijl er niets is getest.
 */
if (!CONFIGURED && process.env.CI) {
  throw new Error(
    'Route tests kunnen niet draaien: zet Redis (UPSTASH_REDIS_REST_URL/_TOKEN of de ' +
      'KV_REST_API_*-aliassen) en MONDAY_API_TOKEN. Ze mogen in CI niet worden overgeslagen.'
  );
}

test.skip(!CONFIGURED, 'heeft Redis + MONDAY_API_TOKEN nodig in de omgeving');

async function token(
  userId: string,
  options: { accountId?: string; expiresInSeconds?: number } = {}
): Promise<string> {
  const { accountId = TEST_AUTH.accountId, expiresInSeconds = 300 } = options;
  return await new SignJWT({ dat: { account_id: Number(accountId), user_id: Number(userId) } })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(new TextEncoder().encode(TEST_AUTH.clientSecret));
}

const auth = (jwt: string) => ({ Authorization: `Bearer ${jwt}` });

const GET_URL = `/api/briefing/${SYNTHETIC_ITEM}`;
const CHECKLIST_URL = `${GET_URL}/checklist`;

const checklistBody = {
  checklist: {
    ownGroup: false,
    sameGroup: false,
    trainingCycle: false,
    homework: true,
    preparatoryAssignment: false,
    trainingActor: false,
  },
  actorItemIds: [],
  mondayChallenge: false,
  actorAnswered: true,
  token: 'absent',
};

test.describe('authenticatie', () => {
  test('beide routes weigeren een verzoek zonder token', async ({ request }) => {
    const responses = [
      await request.get(GET_URL),
      await request.put(CHECKLIST_URL, { data: checklistBody }),
    ];
    for (const response of responses) {
      expect(response.status()).toBe(401);
      expect(await response.json()).toMatchObject({ success: false, error: 'unauthorized' });
    }
  });

  test('weigert een token dat met een ander secret is ondertekend', async ({ request }) => {
    const vreemd = await new SignJWT({
      dat: { account_id: Number(TEST_AUTH.accountId), user_id: Number(TEST_AUTH.plannerId) },
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(new TextEncoder().encode('een-heel-ander-secret'));

    const response = await request.get(GET_URL, { headers: auth(vreemd) });
    expect(response.status()).toBe(401);
  });

  test('weigert een verlopen token', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId, { expiresInSeconds: -60 });
    const response = await request.get(GET_URL, { headers: auth(jwt) });
    expect(response.status()).toBe(401);
  });

  /**
   * Wie de lijst niet mag zien, mag hem ook niet wijzigen. De capability-controle zit in
   * `view-auth.ts`; dit toetst dat de route hem áánroept.
   */
  test('weigert een gebruiker zonder rechten', async ({ request }) => {
    const jwt = await token(TEST_AUTH.strangerId);
    const response = await request.get(GET_URL, { headers: auth(jwt) });
    expect(response.status()).toBe(403);
  });

  /** Lezen mag met `view`; schrijven vraagt `plan`. */
  test('laat een kijker niet schrijven', async ({ request }) => {
    const jwt = await token(TEST_AUTH.viewerId);
    const response = await request.put(CHECKLIST_URL, {
      headers: auth(jwt),
      data: checklistBody,
    });
    expect(response.status()).toBe(403);
  });
});

test.describe('bereik', () => {
  /**
   * Zonder deze controle is het item-id uit de URL een vrij te kiezen sleutel in KV. De server
   * draait met `MONDAY_AGENDA_BOARD_ID=0`, dus geen enkel item hoort erbij — precies wat een
   * planner zou proberen met het id van een ander bord.
   */
  test('weigert een item dat niet op het agendabord staat', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.put(CHECKLIST_URL, {
      headers: auth(jwt),
      data: checklistBody,
    });
    expect([404, 502]).toContain(response.status());
    expect(await response.json()).toMatchObject({ success: false });
  });

  test('leest niets van een item buiten het agendabord', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.get(GET_URL, { headers: auth(jwt) });
    // De lezer haalt de training van het ingestelde bord, dus dit item bestaat daar niet.
    expect(response.ok()).toBe(false);
  });
});

test.describe('invoercontrole', () => {
  test('weigert een body die geen JSON is', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.put(CHECKLIST_URL, {
      headers: { ...auth(jwt), 'Content-Type': 'application/json' },
      data: 'dit is geen json',
    });
    expect(response.status()).toBe(400);
  });

  test('weigert een checklist met ontbrekende velden', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.put(CHECKLIST_URL, {
      headers: auth(jwt),
      data: { checklist: { homework: true }, actorItemIds: [], token: 'absent' },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: 'ongeldige checklist' });
  });

  /**
   * De twee antwoorden op dezelfde vraag. `selectBlocks` wérpt erop, dus dit mag nooit
   * opgeslagen raken — anders komt de tab er niet meer uit.
   */
  test('weigert "eigen groep" en "samen op één groep" tegelijk', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.put(CHECKLIST_URL, {
      headers: auth(jwt),
      data: {
        ...checklistBody,
        checklist: { ...checklistBody.checklist, ownGroup: true, sameGroup: true },
      },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: /niet allebei/ });
  });

  test('weigert een aangewezen acteur terwijl de acteurvraag op nee staat', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.put(CHECKLIST_URL, {
      headers: auth(jwt),
      data: { ...checklistBody, actorItemIds: ['1001'] },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: /acteurvraag op nee/ });
  });

  /** Vóór er iets naar Redis gaat: een oneindig tekstvak hoort er niet in te passen. */
  test('weigert een concept-inhoud die te lang is', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const response = await request.put(CHECKLIST_URL, {
      headers: auth(jwt),
      data: {
        ...checklistBody,
        checklist: { ...checklistBody.checklist, conceptInhoud: 'x'.repeat(20_001) },
      },
    });
    expect(response.status()).toBe(400);
  });

  test('weigert een schrijfactie zonder token', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);
    const { token: _weg, ...zonder } = checklistBody;
    const response = await request.put(CHECKLIST_URL, { headers: auth(jwt), data: zonder });
    expect(response.status()).toBe(400);
  });
});
