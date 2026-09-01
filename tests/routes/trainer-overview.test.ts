import { expect, test } from '@playwright/test';
import { SignJWT } from 'jose';

import { TEST_AUTH } from '../../playwright.config';

/**
 * `GET /api/trainers/overview` over real HTTP.
 *
 * The capability decision itself is unit tested in `lib/recommend/__tests__/view-auth`.
 * This suite exists for the one thing only an HTTP test can catch: that the route WIRES
 * that decision up. A guard that asked for `view` instead of `full`, or a route that
 * forgot to call it at all, passes every unit test in the repo.
 *
 * That matters more here than on most endpoints. The response is the whole roster's
 * evaluation scores — the data `capabilities.ts` reserves for `full`, and which the
 * recommendations list strips out of the restricted row shape. Getting this wiring wrong
 * publishes every trainer's scores to anyone in ITG's Monday account.
 *
 * Read-only: the route makes one Redis GET and writes nothing, so it is safe against
 * whatever `.env.local` points at.
 */

const URL = '/api/trainers/overview';

/**
 * Only Redis is needed — unlike the recommendations suite, this route never calls Monday.
 * Skipped locally when unconfigured, fatal in CI, so a green pipeline can never mean
 * "the authorization wiring was not tested".
 */
const CONFIGURED =
  Boolean(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL) &&
  Boolean(process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN);

if (!CONFIGURED && process.env.CI) {
  throw new Error(
    'Route tests cannot run: provision Redis (UPSTASH_REDIS_REST_URL/_TOKEN or the ' +
      'KV_REST_API_* aliases). They must not be skipped in CI.'
  );
}

test.skip(!CONFIGURED, 'needs Redis in the environment (see docs/m2b/README.md §8)');

async function token(userId: string, expiresInSeconds = 300): Promise<string> {
  return await new SignJWT({
    dat: { account_id: Number(TEST_AUTH.accountId), user_id: Number(userId) },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(new TextEncoder().encode(TEST_AUTH.clientSecret));
}

const auth = (jwt: string) => ({ Authorization: `Bearer ${jwt}` });

test.describe('authentication', () => {
  test('refuses a request with no token', async ({ request }) => {
    const response = await request.get(URL);

    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ success: false, error: 'unauthorized' });
  });

  test('refuses a malformed authorization header', async ({ request }) => {
    for (const header of ['', 'Basic abc', 'abc.def.ghi', 'Bearer']) {
      const response = await request.get(URL, { headers: { Authorization: header } });
      expect(response.status()).toBe(401);
    }
  });

  test('refuses an expired token', async ({ request }) => {
    const stale = await token(TEST_AUTH.financeId, -60);

    expect((await request.get(URL, { headers: auth(stale) })).status()).toBe(401);
  });
});

test.describe('authorization', () => {
  /**
   * The finding this suite was written for. `view` opens the other tabs; it must NOT open
   * this one, because everything this one returns is a score.
   */
  test('refuses a view-only caller', async ({ request }) => {
    const response = await request.get(URL, { headers: auth(await token(TEST_AUTH.viewerId)) });

    expect(response.status()).toBe(403);
    expect(await response.json()).toEqual({ success: false, error: 'forbidden' });
  });

  /** Not a ladder: being able to plan says nothing about being able to see the numbers. */
  test('refuses a view+plan caller', async ({ request }) => {
    const response = await request.get(URL, { headers: auth(await token(TEST_AUTH.plannerId)) });

    expect(response.status()).toBe(403);
  });

  test('refuses a verified user who is in no capability map at all', async ({ request }) => {
    const response = await request.get(URL, { headers: auth(await token(TEST_AUTH.strangerId)) });

    expect(response.status()).toBe(403);
  });

  test('lets a view+full caller through, with the payload shape', async ({ request }) => {
    const response = await request.get(URL, { headers: auth(await token(TEST_AUTH.financeId)) });

    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.trainers)).toBe(true);
    expect(typeof body.data.stale).toBe('boolean');
    // Null is a real answer here: it means the nightly job has never written.
    expect(body.data.writtenAt === null || typeof body.data.writtenAt === 'string').toBe(true);
  });
});
