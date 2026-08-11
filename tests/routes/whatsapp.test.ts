import { expect, test } from '@playwright/test';
import { SignJWT } from 'jose';

import { TEST_AUTH } from '../../playwright.config';

/**
 * The WhatsApp message route over real HTTP.
 *
 * The generation rules, the drift check and the token contract are unit tested in
 * `lib/recommend/__tests__`. What only an HTTP test can catch is that this route WIRES
 * them up — a route that forgot `guard`, or that gated on `view` instead of `plan`, would
 * pass every unit test in the repo.
 *
 * The server runs with `MONDAY_AGENDA_BOARD_ID=0`, which no item can be on, so every
 * mutation is refused structurally. Nothing here can write to Monday, and nothing can
 * touch a real planner's saved message.
 */

const SYNTHETIC_ITEM = '9900000002';

const CONFIGURED =
  Boolean(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL) &&
  Boolean(process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN) &&
  Boolean(process.env.MONDAY_API_TOKEN);

if (!CONFIGURED && process.env.CI) {
  throw new Error(
    'Route tests cannot run: provision Redis (UPSTASH_REDIS_REST_URL/_TOKEN or the ' +
      'KV_REST_API_* aliases) and MONDAY_API_TOKEN. They must not be skipped in CI — ' +
      'see docs/m2b/README.md §8.'
  );
}

test.skip(
  !CONFIGURED,
  'needs Redis + MONDAY_API_TOKEN in the environment (see docs/m2b/README.md §8)'
);

async function token(userId: string): Promise<string> {
  return await new SignJWT({
    dat: { account_id: Number(TEST_AUTH.accountId), user_id: Number(userId) },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(new TextEncoder().encode(TEST_AUTH.clientSecret));
}

const auth = (jwt: string) => ({ Authorization: `Bearer ${jwt}` });

const URL = `/api/recommendations/${SYNTHETIC_ITEM}/whatsapp`;
const saveBody = { edited: 'Ben jij beschikbaar?', base: 'Ben jij beschikbaar?', token: 'absent' };

test.describe('authentication', () => {
  test('all three verbs refuse a request with no token', async ({ request }) => {
    const responses = [
      await request.get(URL),
      await request.put(URL, { data: saveBody }),
      await request.delete(URL, { data: { token: 'absent' } }),
    ];

    for (const response of responses) {
      expect(response.status()).toBe(401);
      expect(await response.json()).toEqual({ success: false, error: 'unauthorized' });
    }
  });

  test('refuses a token signed with the wrong secret', async ({ request }) => {
    const forged = await new SignJWT({
      dat: { account_id: Number(TEST_AUTH.accountId), user_id: Number(TEST_AUTH.plannerId) },
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(new TextEncoder().encode('not-the-servers-secret'));

    expect((await request.get(URL, { headers: auth(forged) })).status()).toBe(401);
  });
});

test.describe('authorization', () => {
  /**
   * The narrowing this route exists to enforce. The main envelope is readable by a
   * `view` holder; the message is not, because it carries klant, locatie and whatever a
   * planner typed into it.
   */
  test('a view-only caller is refused all three verbs', async ({ request }) => {
    const jwt = await token(TEST_AUTH.viewerId);

    const responses = [
      await request.get(URL, { headers: auth(jwt) }),
      await request.put(URL, { headers: auth(jwt), data: saveBody }),
      await request.delete(URL, { headers: auth(jwt), data: { token: 'absent' } }),
    ];

    for (const response of responses) {
      expect(response.status()).toBe(403);
    }
  });

  /** `full` is about seeing rates. It is not about editing shared planning state. */
  test('a finance caller with view,full but no plan is refused', async ({ request }) => {
    const jwt = await token(TEST_AUTH.financeId);

    expect((await request.get(URL, { headers: auth(jwt) })).status()).toBe(403);
  });

  test('a user absent from the map is refused', async ({ request }) => {
    const jwt = await token(TEST_AUTH.strangerId);

    expect((await request.get(URL, { headers: auth(jwt) })).status()).toBe(403);
  });
});

test.describe('the board check', () => {
  /**
   * A `plan` holder reaches the handler and is then stopped by the item's board. The CAS
   * token is not authorization — `absent` is guessable — so this is what keeps a planner
   * from writing records against arbitrary item ids.
   */
  test('refuses an item that is not on the agenda board', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);

    const responses = [
      await request.put(URL, { headers: auth(jwt), data: saveBody }),
      await request.delete(URL, { headers: auth(jwt), data: { token: 'absent' } }),
    ];

    for (const response of responses) {
      // 403 for a real item elsewhere, 403 for one that does not exist at all — no board,
      // nothing writable. Never a 200, and never a 500.
      expect(response.status()).toBe(403);
      expect(await response.json()).toMatchObject({ success: false });
    }
  });

  test('reports a training that cannot be read rather than inventing one', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);

    const response = await request.get(URL, { headers: auth(jwt) });

    // The synthetic id is on no board, so the read finds nothing.
    expect([403, 404]).toContain(response.status());
  });
});

test.describe('input validation', () => {
  test('rejects a body that is not JSON', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);

    const response = await request.put(URL, {
      headers: { ...auth(jwt), 'Content-Type': 'application/json' },
      data: 'not json at all',
    });

    expect([400, 422]).toContain(response.status());
  });

  test('rejects an oversized edit before it can reach Redis', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);

    const response = await request.put(URL, {
      headers: auth(jwt),
      data: { edited: 'x'.repeat(9000), base: 'S', token: 'absent' },
    });

    // Refused on size, before the board check ever runs.
    expect(response.status()).toBe(422);
  });

  test('rejects a save with no token', async ({ request }) => {
    const jwt = await token(TEST_AUTH.plannerId);

    const response = await request.put(URL, {
      headers: auth(jwt),
      data: { edited: 'D', base: 'S' },
    });

    expect(response.status()).toBe(422);
  });
});
