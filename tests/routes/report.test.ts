import { expect, test } from '@playwright/test';

/**
 * `GET /api/report/[itemId]` over echt HTTP.
 *
 * De beslissingen zelf — welke uitkomst welke status krijgt, wanneer er geweigerd wordt —
 * staan in `lib/report/__tests__/run`. Deze suite bestaat voor het enige dat alleen een
 * HTTP-test kan betrappen: dat de route die beslissingen ook WERKELIJK aansluit. Een route
 * die de autorisatie vergeet, of die `CRON_SECRET` leest in plaats van `CONFIG_API_SECRET`,
 * komt door elke unittest in deze repo heen.
 *
 * Dat weegt hier zwaar. Het antwoord is een PDF met de letterlijke antwoorden van
 * deelnemers — vrije tekst over hun trainer — en de route staat open op het internet.
 *
 * Alleen-lezen: er wordt niets naar Monday of Google geschreven.
 */

const SECRET = process.env.CONFIG_API_SECRET ?? '';
const CONFIGURED = SECRET !== '';

if (!CONFIGURED && process.env.CI) {
  throw new Error(
    'Routetests kunnen niet draaien: zet CONFIG_API_SECRET. Ze mogen in CI niet worden ' +
      'overgeslagen — dan zou groen kunnen betekenen dat de autorisatie ongetest bleef.'
  );
}

test.skip(!CONFIGURED, 'heeft CONFIG_API_SECRET in de omgeving nodig');

/** Bestaat niet op enig agendabord; genoeg om de bewaking te bereiken zonder iets te renderen. */
const ONBEKEND = '999999999999';
const auth = (secret: string) => ({ Authorization: `Bearer ${secret}` });

test.describe('authenticatie', () => {
  test('weigert een verzoek zonder token', async ({ request }) => {
    const res = await request.get(`/api/report/${ONBEKEND}`);
    expect(res.status()).toBe(401);
  });

  test('weigert een verkeerd token', async ({ request }) => {
    const res = await request.get(`/api/report/${ONBEKEND}`, {
      headers: auth('niet-het-geheime-woord'),
    });
    expect(res.status()).toBe(401);
  });

  /** De sleutel van de cron hoort hier niet te werken; de routes zijn bewust gescheiden. */
  test('weigert het cron-geheim', async ({ request }) => {
    const cron = process.env.CRON_SECRET ?? '';
    test.skip(cron === '' || cron === SECRET, 'geen los CRON_SECRET geconfigureerd');
    const res = await request.get(`/api/report/${ONBEKEND}`, { headers: auth(cron) });
    expect(res.status()).toBe(401);
  });
});

test.describe('invoercontrole', () => {
  /**
   * De autorisatie gaat VOOR de vormcontrole. Andersom zou een onbekende het verschil
   * tussen een geldig en een ongeldig item-id kunnen aflezen zonder token.
   */
  test('een ongeldig item-id zonder token geeft 401, niet 400', async ({ request }) => {
    const res = await request.get('/api/report/geen-getal');
    expect(res.status()).toBe(401);
  });

  test('weigert een item-id dat geen getal is', async ({ request }) => {
    const res = await request.get('/api/report/geen-getal', { headers: auth(SECRET) });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('item-id');
  });
});

test.describe('uitkomsten', () => {
  test('geeft 404 voor een training die niet bestaat', async ({ request }) => {
    const res = await request.get(`/api/report/${ONBEKEND}`, { headers: auth(SECRET) });
    expect(res.status()).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toContain(ONBEKEND);
  });
});
