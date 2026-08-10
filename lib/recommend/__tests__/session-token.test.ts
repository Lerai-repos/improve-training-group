import { SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

import {
  sessionTokenConfigFromEnv,
  verifySessionToken,
  type SessionTokenConfig,
} from '../session-token';

/**
 * The fixtures are GENERATED, not captured.
 *
 * A real Monday token carries an `exp` and would be stale within the hour, and CI cannot
 * verify one at all without the production client secret — so a committed sample would
 * either be skipped or, worse, quietly asserted against a disabled check. Signing our
 * own with a test secret and an injected clock tests the logic exactly; that the shape
 * matches what Monday actually issues is verified once, by hand, in the app spike
 * (`docs/build/07-monday-app.md` acceptance criterion 1) — which is where "does reality
 * match the documented shape" belongs.
 */

const SECRET = 'test-client-secret-not-a-real-one';
const ACCOUNT = '12345678';
const USER = '87654321';
const NOW = new Date('2026-08-06T12:00:00Z');

const config: SessionTokenConfig = {
  clientSecret: SECRET,
  expectedAccountId: ACCOUNT,
  now: NOW,
};

const key = (secret = SECRET): Uint8Array => new TextEncoder().encode(secret);

interface TokenOptions {
  dat?: unknown;
  secret?: string;
  alg?: string;
  expiresAt?: Date | null;
}

async function token(options: TokenOptions = {}): Promise<string> {
  const {
    dat = { account_id: Number(ACCOUNT), user_id: Number(USER) },
    secret = SECRET,
    alg = 'HS256',
    expiresAt = new Date(NOW.getTime() + 60_000),
  } = options;

  const jwt = new SignJWT({ dat })
    .setProtectedHeader({ alg })
    .setIssuedAt(Math.floor(NOW.getTime() / 1000));

  if (expiresAt !== null) {
    jwt.setExpirationTime(Math.floor(expiresAt.getTime() / 1000));
  }

  return await jwt.sign(key(secret));
}

describe('verifySessionToken', () => {
  it('accepts a well-formed token and returns the nested claims', async () => {
    const result = await verifySessionToken(await token(), config);

    expect(result).toEqual({ ok: true, session: { accountId: ACCOUNT, userId: USER } });
  });

  /**
   * Monday nests the claims under `dat`. Reading `payload.account_id` would be
   * `undefined` for every genuine token — which is only safe if the comparison treats
   * absence as a failure, and this asserts we are reading the right place to begin with.
   */
  it('reads the ids from dat, not from the top level', async () => {
    const misplaced = await token({ dat: {} });
    expect(await verifySessionToken(misplaced, config)).toEqual({
      ok: false,
      reason: 'missing_claims',
    });

    const topLevel = await new SignJWT({ account_id: Number(ACCOUNT), user_id: Number(USER) })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(Math.floor((NOW.getTime() + 60_000) / 1000))
      .sign(key());
    expect(await verifySessionToken(topLevel, config)).toEqual({
      ok: false,
      reason: 'missing_claims',
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = await token({ secret: 'someone-elses-secret' });
    expect(await verifySessionToken(forged, config)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects a tampered payload', async () => {
    const [header, , signature] = (await token()).split('.');
    const swapped = Buffer.from(
      JSON.stringify({ dat: { account_id: Number(ACCOUNT), user_id: '999' } })
    ).toString('base64url');

    expect(await verifySessionToken(`${header}.${swapped}.${signature}`, config)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects an expired token', async () => {
    const stale = await token({ expiresAt: new Date(NOW.getTime() - 1_000) });
    expect(await verifySessionToken(stale, config)).toEqual({ ok: false, reason: 'expired' });
  });

  /**
   * A token with no `exp` never goes stale, so a leaked one would work forever. Absence
   * has to be a failure, not a permanent pass.
   */
  it('rejects a token with no expiry at all', async () => {
    const eternal = await token({ expiresAt: null });
    expect(await verifySessionToken(eternal, config)).toEqual({
      ok: false,
      reason: 'missing_claims',
    });
  });

  /**
   * The classic JWT forgery: the verifier trusts the header's `alg`. `none` removes the
   * signature entirely, and naming an asymmetric algorithm invites verifying an RS256
   * token with the public key as an HMAC secret. Pinning HS256 refuses both.
   */
  it('refuses an algorithm other than HS256', async () => {
    const hs512 = await token({ alg: 'HS512' });
    expect(await verifySessionToken(hs512, config)).toEqual({
      ok: false,
      reason: 'wrong_algorithm',
    });

    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(
      JSON.stringify({ dat: { account_id: Number(ACCOUNT), user_id: Number(USER) }, exp: 9e9 })
    ).toString('base64url')}.`;
    expect((await verifySessionToken(unsigned, config)).ok).toBe(false);
  });

  it('refuses a token from another Monday account', async () => {
    const other = await token({ dat: { account_id: 99, user_id: Number(USER) } });
    expect(await verifySessionToken(other, config)).toEqual({ ok: false, reason: 'wrong_account' });
  });

  it('refuses a dat that is not an object', async () => {
    for (const dat of ['nope', 42, null, [1, 2]]) {
      expect(await verifySessionToken(await token({ dat }), config)).toEqual({
        ok: false,
        reason: 'missing_claims',
      });
    }
  });

  it('refuses ids that are not plain numeric', async () => {
    // Whitespace and signs are how a lookalike id gets past a loose comparison.
    for (const account_id of [` ${ACCOUNT} `, `+${ACCOUNT}`, `${ACCOUNT}\n`, 1.5, -1]) {
      expect(await verifySessionToken(await token({ dat: { account_id, user_id: 1 } }), config)).toEqual(
        { ok: false, reason: 'missing_claims' }
      );
    }
  });

  it('accepts numeric ids sent as strings, since they are the same id', async () => {
    const asStrings = await token({ dat: { account_id: ACCOUNT, user_id: USER } });
    expect(await verifySessionToken(asStrings, config)).toEqual({
      ok: true,
      session: { accountId: ACCOUNT, userId: USER },
    });
  });

  it('refuses garbage rather than throwing', async () => {
    for (const junk of ['', '   ', 'not.a.jwt', 'a.b', 'eyJhbGciOiJIUzI1NiJ9']) {
      expect((await verifySessionToken(junk, config)).ok).toBe(false);
    }
  });
});

describe('sessionTokenConfigFromEnv', () => {
  const VARS = ['MONDAY_APP_CLIENT_SECRET', 'MONDAY_ACCOUNT_ID'];

  afterEach(() => {
    for (const v of VARS) {
      delete process.env[v];
    }
  });

  it('reads both variables', () => {
    process.env.MONDAY_APP_CLIENT_SECRET = SECRET;
    process.env.MONDAY_ACCOUNT_ID = ACCOUNT;

    expect(sessionTokenConfigFromEnv()).toEqual({
      clientSecret: SECRET,
      expectedAccountId: ACCOUNT,
    });
  });

  /**
   * Neither may default. A missing secret cannot mean "skip verification" and a missing
   * account cannot mean "any account" — both would turn a deploy mistake into an open
   * endpoint whose symptom is that everything works.
   */
  it('refuses to run unconfigured, naming what is missing', () => {
    expect(() => sessionTokenConfigFromEnv()).toThrow(/MONDAY_APP_CLIENT_SECRET/);
    expect(() => sessionTokenConfigFromEnv()).toThrow(/MONDAY_ACCOUNT_ID/);

    process.env.MONDAY_APP_CLIENT_SECRET = SECRET;
    expect(() => sessionTokenConfigFromEnv()).toThrow(/MONDAY_ACCOUNT_ID/);
  });

  it('treats a blank variable as missing', () => {
    process.env.MONDAY_APP_CLIENT_SECRET = '   ';
    process.env.MONDAY_ACCOUNT_ID = ACCOUNT;
    expect(() => sessionTokenConfigFromEnv()).toThrow(/MONDAY_APP_CLIENT_SECRET/);
  });
});
