import { expect, test } from '@playwright/test';

import { TEST_CRON_SECRET } from '../../playwright.config';

/**
 * The workload refresh cron over real HTTP.
 *
 * What only an HTTP test can catch is that the route is wired at all: that it is reachable
 * at the path `vercel.json` schedules, that it checks its bearer before doing anything, and
 * that a run which cannot scan reports a failure instead of a cheerful 200. The cache's own
 * rules — what a failure may overwrite, when the lock is skipped — are unit-tested in
 * `lib/recommend/__tests__/assignment-cache.test.ts`.
 *
 * The server runs with `MONDAY_AGENDA_BOARD_ID=0`, so an authorized run scans a board that
 * cannot exist. That is deliberate: it exercises the whole authorized path without touching
 * ITG's real Agenda board, and the only outcomes it can produce are a failure or an empty
 * scan — never a write against live data.
 */

const URL = '/api/cron/refresh-workload';

const CONFIGURED =
  Boolean(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL) &&
  Boolean(process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN) &&
  Boolean(process.env.MONDAY_API_TOKEN);

/** Skipping is a local convenience, never an outcome in CI — see `briefing.test.ts`. */
if (!CONFIGURED && process.env.CI) {
  throw new Error(
    'Route tests kunnen niet draaien: zet Redis (UPSTASH_REDIS_REST_URL/_TOKEN of de ' +
      'KV_REST_API_*-aliassen) en MONDAY_API_TOKEN. Ze mogen in CI niet worden overgeslagen.'
  );
}

test.skip(!CONFIGURED, 'heeft Redis + MONDAY_API_TOKEN nodig in de omgeving');

/**
 * Serial, and that is load-bearing rather than tidy.
 *
 * The suite is `fullyParallel`, and every authorized test here contends for the SAME
 * single-flight lock (`assignments:0`). Run in parallel, both requests of the concurrency
 * test below could be queued behind a different test's refresh and pass without either of
 * them ever owning one — a green assertion about a race that never happened. Serial makes
 * the only lock holders the requests each test starts itself.
 */
test.describe.configure({ mode: 'serial' });

const auth = (secret: string) => ({ Authorization: `Bearer ${secret}` });

test.describe('authenticatie', () => {
  /**
   * The route is publicly routable — Vercel calls it over the internet — so the bearer is
   * the only thing between the open web and a full board scan on demand.
   */
  test('weigert een verzoek zonder token', async ({ request }) => {
    const response = await request.get(URL);
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'unauthorized' });
  });

  test('weigert een verkeerd token', async ({ request }) => {
    const response = await request.get(URL, { headers: auth('niet-het-goede-secret') });
    expect(response.status()).toBe(401);
  });

  /** A bare secret without the `Bearer` prefix is not a credential this route accepts. */
  test('weigert een token zonder Bearer-prefix', async ({ request }) => {
    const response = await request.get(URL, { headers: { Authorization: TEST_CRON_SECRET } });
    expect(response.status()).toBe(401);
  });

  test('doet geen enkele scan voor een afgewezen aanroeper', async ({ request }) => {
    // A rejected call must be cheap: no Redis, no Monday, no lock. If the guard ran after
    // the deps were built, an unauthorized caller could still cost a board scan.
    const started = Date.now();
    await request.get(URL);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

test.describe('de run zelf', () => {
  /**
   * Authorized, against a board that cannot exist. Either outcome is correct — an empty
   * scan or a refusal — but the shape must be the documented one, and a failure must never
   * be reported as `ok: true`.
   */
  test('rapporteert de uitkomst in de afgesproken vorm', async ({ request }) => {
    const response = await request.get(URL, { headers: auth(TEST_CRON_SECRET) });
    const body = await response.json();

    expect([200, 500]).toContain(response.status());
    expect(body).toMatchObject({ ok: response.status() === 200 });
    expect(typeof body.durationMs).toBe('number');
    if (response.status() === 200) {
      expect(typeof body.refreshed).toBe('boolean');
    } else {
      expect(typeof body.error).toBe('string');
    }
  });

  /**
   * Two runs at once, which is what an overlapping tick or a manual trigger produces.
   *
   * The invariant is NOT "exactly one owns the refresh" — the route asks for
   * `awaitContended`, so a request that finds the lock held waits and then takes over if
   * the holder produced nothing. What must hold is that the pair cannot BOTH walk away
   * having done nothing: at least one of them either refreshed or failed trying.
   *
   * That is the property the whole finding was about. A run reporting `refreshed: false`
   * is claiming somebody else's scan landed in the cache, and if both could claim that,
   * the columns would stay blank while two 200s said otherwise.
   *
   * The precise single-flight and take-over semantics are unit-tested in
   * `lib/recommend/__tests__/assignment-cache.test.ts`, where the scan is controllable;
   * over HTTP against a board that cannot exist, only this is deterministic.
   */
  test('kan niet allebei niets doen', async ({ request }) => {
    const [first, second] = await Promise.all([
      request.get(URL, { headers: auth(TEST_CRON_SECRET) }),
      request.get(URL, { headers: auth(TEST_CRON_SECRET) }),
    ]);

    const results = await Promise.all(
      [first, second].map(async (response) => ({
        status: response.status(),
        body: await response.json(),
      }))
    );

    for (const { status, body } of results) {
      // `refreshed: false` may only ever appear on a 200, and only as `locked`.
      if (body.refreshed === false) {
        expect(status).toBe(200);
        expect(body).toMatchObject({ ok: true, reason: 'locked' });
      }
    }

    const didNothing = results.filter(({ body }) => body.refreshed === false);
    expect(didNothing.length, 'both runs skipped, so nothing refreshed the cache').toBeLessThan(2);
  });
});
