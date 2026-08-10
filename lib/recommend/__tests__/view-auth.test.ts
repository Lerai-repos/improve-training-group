import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { parseCapabilityList, parseCapabilityMap } from '../capabilities';
import { authorizeToken, readBearerToken, type AuthDeps } from '../view-auth';

const SECRET = 'test-client-secret-not-a-real-one';
const ACCOUNT = '12345678';
const NOW = new Date('2026-08-06T12:00:00Z');

const VIEWER = '111';
const PLANNER = '222';
const FINANCE = '333';
const STRANGER = '999';

function deps(caps: string, defaults = ''): AuthDeps {
  return {
    // The clock is injected so the fixtures do not silently expire against wall time.
    session: { clientSecret: SECRET, expectedAccountId: ACCOUNT, now: NOW },
    policy: { map: parseCapabilityMap(caps), defaults: parseCapabilityList(defaults, 'test') },
  };
}

const CAPS = `${VIEWER}:view; ${PLANNER}:view,plan; ${FINANCE}:view,full`;

async function tokenFor(userId: string, accountId = ACCOUNT): Promise<string> {
  return await new SignJWT({ dat: { account_id: Number(accountId), user_id: Number(userId) } })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor((NOW.getTime() + 60_000) / 1000))
    .sign(new TextEncoder().encode(SECRET));
}

describe('readBearerToken', () => {
  const withHeader = (value: string | null): Request =>
    new Request('https://example.test/api', value === null ? {} : { headers: { authorization: value } });

  it('reads a bearer token, case-insensitively and trimmed', () => {
    expect(readBearerToken(withHeader('Bearer abc.def.ghi'))).toBe('abc.def.ghi');
    expect(readBearerToken(withHeader('  bearer   abc.def.ghi  '))).toBe('abc.def.ghi');
  });

  it('returns null for anything that is not one', () => {
    for (const header of [null, '', 'abc.def.ghi', 'Basic abc', 'Bearer', 'Bearer    ']) {
      expect(readBearerToken(withHeader(header))).toBeNull();
    }
  });

  /**
   * Not a query parameter. URLs land in access logs and browser history, and this token
   * authenticates a person. (The Monday *webhook* secret does ride on the URL — that is
   * Monday's choice for a server-to-server call we do not control.)
   */
  it('does not accept a token from the query string', () => {
    expect(readBearerToken(new Request('https://example.test/api?token=abc.def.ghi'))).toBeNull();
  });
});

describe('authorizeToken', () => {
  it('admits a listed user with the capability required', async () => {
    const result = await authorizeToken(await tokenFor(PLANNER), deps(CAPS), 'plan');

    expect(result).toMatchObject({
      ok: true,
      caller: { session: { userId: PLANNER, accountId: ACCOUNT }, caps: { view: true, plan: true } },
    });
  });

  it('refuses an unverifiable token with 401', async () => {
    const forged = await new SignJWT({ dat: { account_id: Number(ACCOUNT), user_id: 1 } })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor((NOW.getTime() + 60_000) / 1000))
      .sign(new TextEncoder().encode('wrong-secret'));

    expect(await authorizeToken(forged, deps(CAPS), 'view')).toEqual({
      ok: false,
      status: 401,
      error: 'unauthorized',
    });
  });

  it('refuses a token from another Monday account with 401', async () => {
    const other = await tokenFor(PLANNER, '87654321');
    expect(await authorizeToken(other, deps(CAPS), 'view')).toMatchObject({ status: 401 });
  });

  /**
   * The fail-closed default. An unset variable in a fresh environment must deny rather
   * than expose trainer rates to everyone holding a valid Monday session.
   */
  it('refuses a user absent from the map — including GET', async () => {
    expect(await authorizeToken(await tokenFor(STRANGER), deps(CAPS), 'view')).toEqual({
      ok: false,
      status: 403,
      error: 'forbidden',
    });
  });

  it('an empty map denies everyone', async () => {
    expect(await authorizeToken(await tokenFor(PLANNER), deps(''), 'view')).toMatchObject({
      status: 403,
    });
  });

  it('lets a view-only user read but not mutate', async () => {
    expect(await authorizeToken(await tokenFor(VIEWER), deps(CAPS), 'view')).toMatchObject({
      ok: true,
    });
    expect(await authorizeToken(await tokenFor(VIEWER), deps(CAPS), 'plan')).toEqual({
      ok: false,
      status: 403,
      error: 'forbidden',
    });
  });

  /**
   * No hierarchy: seeing exact rates does not imply permission to spend money on
   * recomputation or to edit state every other planner sees.
   */
  it('does not let full imply plan', async () => {
    const result = await authorizeToken(await tokenFor(FINANCE), deps(CAPS), 'plan');
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  /**
   * ITG opted for no gating (6-Aug-2026), so in production this is the whole policy:
   * an empty map and a default that grants everything to any verified account member.
   */
  it('grants every account member the default, with no map at all', async () => {
    const open = deps('', 'view,plan,full');

    expect(await authorizeToken(await tokenFor(STRANGER), open, 'view')).toMatchObject({
      ok: true,
      caller: { caps: { view: true, plan: true, full: true } },
    });
    expect(await authorizeToken(await tokenFor(STRANGER), open, 'plan')).toMatchObject({
      ok: true,
    });

    // A narrower default still gates: `view` alone cannot mutate.
    const readOnly = deps('', 'view');
    expect(await authorizeToken(await tokenFor(STRANGER), readOnly, 'plan')).toMatchObject({
      status: 403,
    });
  });

  /**
   * The response says only `unauthorized` or `forbidden`. Someone probing the endpoint
   * should not be told which part of their forgery needs work; the specific reason goes
   * to the log.
   */
  it('says nothing about why', async () => {
    const expired = await new SignJWT({ dat: { account_id: Number(ACCOUNT), user_id: 1 } })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(1)
      .sign(new TextEncoder().encode(SECRET));

    const result = await authorizeToken(expired, deps(CAPS), 'view');

    expect(result).toEqual({ ok: false, status: 401, error: 'unauthorized' });
    expect(JSON.stringify(result)).not.toMatch(/expired|account|signature/i);
  });
});
