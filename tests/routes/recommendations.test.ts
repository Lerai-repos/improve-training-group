import { expect, test } from '@playwright/test';
import { SignJWT } from 'jose';

import { TEST_AUTH } from '../../playwright.config';

/**
 * The recommendations API over real HTTP.
 *
 * The decisions themselves are unit tested in `lib/recommend/__tests__` — this suite
 * exists for what only an HTTP test can catch: that the route WIRES them up. A route
 * that forgot to call `guard`, or that returned 200 with a body nobody validated, would
 * pass every unit test in the repo.
 *
 * The server is started by `playwright.config.ts` with a test client secret, so these
 * tokens verify for real rather than against a stub. Everything here uses a synthetic
 * item id: `GET` reads one absent Redis key, and the mutating routes ask Monday whether
 * that id exists — it does not, so they stop at the board check. Nothing is written to
 * Redis or to Monday.
 */

const SYNTHETIC_ITEM = '9900000001';
const ACTION_ID = 'route-test-1234';

/**
 * These routes are not mocked at the boundary — they run against whatever Redis and
 * Monday credentials `.env.local` provides. That is the point (a wiring test that stubs
 * the wiring proves nothing), but it means a machine without them would fail with 500s
 * that say nothing about the code.
 *
 * Skipped rather than failed, with the reason attached, so an unconfigured environment
 * reports "not run here" instead of "broken".
 *
 * Safety does NOT rest on `SYNTHETIC_ITEM` being absent from Monday: the server is
 * started with `MONDAY_AGENDA_BOARD_ID=0`, which no item can be on, so the mutating
 * routes are refused structurally and can never queue real work.
 */
const CONFIGURED =
  Boolean(process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL) &&
  Boolean(process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN) &&
  Boolean(process.env.MONDAY_API_TOKEN);

/**
 * Skipping is a local convenience, never a CI outcome.
 *
 * A green pipeline that ran none of these would say the authorization wiring is fine
 * while having tested nothing at all — the failure mode is silence, which is exactly
 * what a route suite exists to prevent. So CI fails loudly and tells the operator what
 * to provision; a developer's laptop without credentials just skips.
 */
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

const GET_URL = `/api/recommendations/${SYNTHETIC_ITEM}`;
const RECALCULATE_URL = `${GET_URL}/recalculate`;
const APPROACHED_URL = `${GET_URL}/approached`;

const approachedBody = { generation: 1, trainerItemId: '1001', approached: true };

test.describe('authentication', () => {
  test('every route refuses a request with no token', async ({ request }) => {
    const responses = [
      await request.get(GET_URL),
      await request.post(RECALCULATE_URL, { data: { actionId: ACTION_ID } }),
      await request.put(APPROACHED_URL, { data: approachedBody }),
    ];

    for (const response of responses) {
      expect(response.status()).toBe(401);
      expect(await response.json()).toEqual({ success: false, error: 'unauthorized' });
    }
  });

  test('refuses a malformed authorization header', async ({ request }) => {
    for (const header of ['', 'Basic abc', 'abc.def.ghi', 'Bearer']) {
      const response = await request.get(GET_URL, { headers: { Authorization: header } });
      expect(response.status()).toBe(401);
    }
  });

  test('refuses a token signed with the wrong secret', async ({ request }) => {
    const forged = await new SignJWT({
      dat: { account_id: Number(TEST_AUTH.accountId), user_id: Number(TEST_AUTH.plannerId) },
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
      .sign(new TextEncoder().encode('not-the-servers-secret'));

    const response = await request.get(GET_URL, { headers: auth(forged) });

    expect(response.status()).toBe(401);
    // The reason goes to the log, never to the caller.
    expect(await response.json()).toEqual({ success: false, error: 'unauthorized' });
  });

  test('refuses an expired token', async ({ request }) => {
    const stale = await token(TEST_AUTH.plannerId, { expiresInSeconds: -60 });
    expect((await request.get(GET_URL, { headers: auth(stale) })).status()).toBe(401);
  });

  test('refuses a token from another Monday account', async ({ request }) => {
    const other = await token(TEST_AUTH.plannerId, { accountId: '87654321' });
    expect((await request.get(GET_URL, { headers: auth(other) })).status()).toBe(401);
  });
});

test.describe('authorization', () => {
  /**
   * The fail-closed default, over the wire. A valid Monday session is not access: an
   * unlisted user must not be able to read trainer rates for an arbitrary item id.
   */
  test('a verified user who is not in the map is refused everything', async ({ request }) => {
    const jwt = await token(TEST_AUTH.strangerId);

    const responses = [
      await request.get(GET_URL, { headers: auth(jwt) }),
      await request.post(RECALCULATE_URL, { headers: auth(jwt), data: { actionId: ACTION_ID } }),
      await request.put(APPROACHED_URL, { headers: auth(jwt), data: approachedBody }),
    ];

    for (const response of responses) {
      expect(response.status()).toBe(403);
      expect(await response.json()).toEqual({ success: false, error: 'forbidden' });
    }
  });

  test('a view-only user may read but not mutate', async ({ request }) => {
    const jwt = await token(TEST_AUTH.viewerId);

    expect((await request.get(GET_URL, { headers: auth(jwt) })).status()).toBe(200);
    expect(
      (
        await request.post(RECALCULATE_URL, { headers: auth(jwt), data: { actionId: ACTION_ID } })
      ).status()
    ).toBe(403);
    expect(
      (await request.put(APPROACHED_URL, { headers: auth(jwt), data: approachedBody })).status()
    ).toBe(403);
  });

  /**
   * No hierarchy, over the wire: seeing exact rates does not imply permission to spend
   * money on a recomputation.
   */
  test('a full user is still refused planning', async ({ request }) => {
    const jwt = await token(TEST_AUTH.financeId);

    expect((await request.get(GET_URL, { headers: auth(jwt) })).status()).toBe(200);
    expect(
      (
        await request.post(RECALCULATE_URL, { headers: auth(jwt), data: { actionId: ACTION_ID } })
      ).status()
    ).toBe(403);
  });
});

test.describe('reading a training that was never triggered', () => {
  test('answers idle, with the caller’s capabilities', async ({ request }) => {
    const response = await request.get(GET_URL, {
      headers: auth(await token(TEST_AUTH.financeId)),
    });

    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { state: { kind: 'idle' }, caps: { canPlan: false, canViewFull: true } },
    });
  });

  /**
   * Both a `view` and a `plan` user receive `RestrictedRow`, so the rows alone cannot
   * tell them apart. Without this envelope the view would render controls that 403.
   */
  test('tells a view-only caller it may not plan', async ({ request }) => {
    const response = await request.get(GET_URL, {
      headers: auth(await token(TEST_AUTH.viewerId)),
    });

    expect((await response.json()).data.caps).toEqual({ canPlan: false, canViewFull: false });
  });
});

test.describe('the mutating routes validate before they act', () => {
  test('rejects a body that is not JSON', async ({ request }) => {
    const response = await request.post(RECALCULATE_URL, {
      headers: { ...auth(await token(TEST_AUTH.plannerId)), 'Content-Type': 'application/json' },
      data: 'not json at all',
    });

    expect(response.status()).toBe(400);
  });

  /**
   * The `actionId` becomes a Redis key component, so it is validated BEFORE the board
   * lookup — which also means a malformed one costs no Monday call.
   */
  test('rejects a malformed actionId with 400, not 403', async ({ request }) => {
    const response = await request.post(RECALCULATE_URL, {
      headers: auth(await token(TEST_AUTH.plannerId)),
      data: { actionId: `x:${SYNTHETIC_ITEM}:1` },
    });

    expect(response.status()).toBe(400);
  });

  test('rejects a malformed approached body with 400', async ({ request }) => {
    const response = await request.put(APPROACHED_URL, {
      headers: auth(await token(TEST_AUTH.plannerId)),
      data: { generation: 0, trainerItemId: 'nope', approached: 'yes' },
    });

    expect(response.status()).toBe(400);
  });

  /**
   * Reading is account-wide and historical; mutating is confined to the Agenda board.
   * A synthetic id exists on no board, so a well-formed request still stops here — and
   * nothing is queued.
   */
  test('refuses a well-formed mutation for an item that is not on the Agenda board', async ({
    request,
  }) => {
    const jwt = await token(TEST_AUTH.plannerId);

    const recalculate = await request.post(RECALCULATE_URL, {
      headers: auth(jwt),
      data: { actionId: ACTION_ID },
    });
    const approached = await request.put(APPROACHED_URL, {
      headers: auth(jwt),
      data: approachedBody,
    });

    expect(recalculate.status()).toBe(403);
    expect(approached.status()).toBe(403);

    // And the training was never queued, so the refusal cost nothing.
    const after = await request.get(GET_URL, { headers: auth(jwt) });
    expect((await after.json()).data.state).toEqual({ kind: 'idle' });
  });
});
