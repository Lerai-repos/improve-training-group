/* eslint-disable no-console */
import { config as loadEnv } from 'dotenv';

loadEnv({ path: '.env.local' });

import { SignJWT } from 'jose';

/**
 * Exercise the deployed recommendations API with a REAL session token.
 *
 * Monday's `sessionToken` is an HS256 JWT signed with the app's client secret, which we
 * hold — so a token can be minted exactly as Monday would and the whole backend tested
 * without the app being installed. That matters: app installation needs an ITG admin,
 * and everything behind it (signature verification, the account check, the capability
 * policy, state resolution, the board guard) is testable today.
 *
 * What this does NOT cover is the iframe: `monday.get('context')`, name resolution as
 * the logged-in user, and the relation write. Those need the real thing. Everything
 * else, this proves.
 *
 * Usage:
 *   pnpm view:smoke <mondayItemId> [--base=https://…] [--user=123] [--mutate]
 *
 * Read-only by default. `--mutate` additionally queues a REAL recalculation and writes
 * (then removes) a WhatsApp message, which is the only exercise the Lua CAS script gets.
 * Point it at a PREVIEW deployment aimed at the TEST board — real
 * provider calls, real money, a real board write — so it is opt-in.
 */

const CONFLICT = 409;

function arg(name: string): string | null {
  const found = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : null;
}

function requireEnv(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (value === '') {
    throw new Error(`Missing ${name} — the smoke test signs its own token and needs it`);
  }
  return value;
}

const itemId = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (itemId === undefined) {
  console.error('Usage: pnpm view:smoke <mondayItemId> [--base=…] [--user=…] [--mutate]');
  process.exit(1);
}

const PRODUCTION = 'https://improve-training-group.vercel.app';
// Blank counts as absent: `PUBLIC_BASE_URL` is present-but-empty locally, and `??`
// would happily hand fetch an empty base.
const base = arg('base') ?? ((process.env.PUBLIC_BASE_URL ?? '').trim() || PRODUCTION);
const userId = arg('user') ?? '1';
const mutate = process.argv.includes('--mutate');

const secret = requireEnv('MONDAY_APP_CLIENT_SECRET');

/**
 * ITG's Monday account, confirmed live via `{ me { account { id } } }`. Defaulted rather
 * than required, because it is an identifier and not a secret — and if the deployment
 * disagrees, the call comes back 401 and that IS the finding.
 */
const ITG_ACCOUNT_ID = '16544979';
const accountId =
  arg('account') ?? ((process.env.MONDAY_ACCOUNT_ID ?? '').trim() || ITG_ACCOUNT_ID);

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  if (!ok) {
    failures += 1;
  }
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
}

async function token(options: { secret?: string; account?: string; expiresIn?: number } = {}) {
  const {
    secret: signingSecret = secret,
    account = accountId,
    expiresIn = 300,
  } = options;
  return await new SignJWT({ dat: { account_id: Number(account), user_id: Number(userId) } })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresIn)
    .sign(new TextEncoder().encode(signingSecret));
}

async function call(
  path: string,
  init: RequestInit = {},
  jwt?: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      ...(jwt === undefined ? {} : { Authorization: `Bearer ${jwt}` }),
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Leave it as text — an HTML error page is itself the finding.
  }
  return { status: res.status, body };
}

const url = `/api/recommendations/${itemId}`;

async function main(): Promise<void> {
  console.log(`\nTarget: ${base}${url}   (user ${userId}, account ${accountId})\n`);

  console.log('== A. the auth gate ==');
  check('no token is refused', (await call(url)).status === 401, '401');
  check('garbage is refused', (await call(url, {}, 'not.a.jwt')).status === 401, '401');
  check(
    'another secret is refused',
    (await call(url, {}, await token({ secret: 'wrong-secret-entirely' }))).status === 401,
    '401'
  );
  check(
    'another Monday account is refused',
    (await call(url, {}, await token({ account: '99999999' }))).status === 401,
    '401'
  );
  check(
    'an expired token is refused',
    (await call(url, {}, await token({ expiresIn: -60 }))).status === 401,
    '401'
  );

  console.log('\n== B. reading the list ==');
  const jwt = await token();
  const read = await call(url, {}, jwt);
  check('a valid token is admitted', read.status === 200, `${read.status}`);
  if (read.status === 503) {
    console.log('\n  → 503 means MONDAY_ACCOUNT_ID / the client secret is not set in Vercel.\n');
  }
  console.log(`  ${JSON.stringify(read.body, null, 2).split('\n').slice(0, 24).join('\n  ')}`);

  console.log('\n== C. the mutating routes validate before they act ==');
  const badBody = await call(
    `${url}/recalculate`,
    { method: 'POST', body: JSON.stringify({ actionId: 'x:collide:1' }) },
    jwt
  );
  check('a malformed actionId is 400', badBody.status === 400, `${badBody.status}`);

  const stale = await call(
    `${url}/approached`,
    {
      method: 'PUT',
      body: JSON.stringify({ generation: 999, trainerItemId: '1', approached: true }),
    },
    jwt
  );
  check(
    'a stale generation is refused',
    stale.status === CONFLICT || stale.status === 403,
    `${stale.status} ${JSON.stringify(stale.body)}`
  );

  console.log('\n== D. the WhatsApp message ==');
  const wa = await call(`${url}/whatsapp`, {}, jwt);
  check(
    'the message route answers',
    wa.status === 200 || wa.status === 403 || wa.status === 404,
    `${wa.status} ${JSON.stringify(wa.body).slice(0, 200)}`
  );
  if (wa.status === 200) {
    const data = (wa.body as { data?: { generated?: string; token?: string } }).data;
    check(
      'it generated a message',
      typeof data?.generated === 'string' && data.generated.startsWith('Ben jij beschikbaar?'),
      String(data?.generated).split('\n').slice(0, 3).join(' | ')
    );
    check('it carries a token', typeof data?.token === 'string', String(data?.token));
  }
  check(
    'the message needs a token like everything else',
    (await call(`${url}/whatsapp`)).status === 401,
    '401'
  );

  if (!mutate) {
    console.log('\n(Read-only. Pass --mutate to queue a real recalculation and exercise the');
    console.log(' WhatsApp CAS script — only against a preview aimed at the TEST board.)');
  } else {
    console.log('\n== D. a REAL recalculation ==');
    const actionId = `smoke${Date.now()}`;
    const first = await call(
      `${url}/recalculate`,
      { method: 'POST', body: JSON.stringify({ actionId }) },
      jwt
    );
    check('queued', first.status === 200, JSON.stringify(first.body));

    // The same actionId again: idempotent, not a second computation.
    const second = await call(
      `${url}/recalculate`,
      { method: 'POST', body: JSON.stringify({ actionId }) },
      jwt
    );
    check(
      'the same actionId does not buy a second run',
      JSON.stringify(second.body).includes('duplicate'),
      JSON.stringify(second.body)
    );
    console.log('\n  Watch it land:  pnpm view:smoke ' + itemId);

    /**
     * The only exercise the Lua CAS script ever gets — `redis.sha1hex` needs a real
     * Redis, so the unit tests run against the TypeScript twin.
     *
     * Writes and then removes a message on THIS item. Safe only because `--mutate` is
     * documented for a preview deployment pointed at the TEST board; a real Agenda item
     * would mean overwriting a planner's note, and snapshot-and-restore is no safer,
     * since the restore would clobber whatever they saved in between.
     */
    console.log('\n== E. the WhatsApp CAS script (writes, then cleans up) ==');
    const before = await call(`${url}/whatsapp`, {}, jwt);
    const beforeData = (before.body as { data?: { generated?: string; token?: string } }).data;
    if (before.status !== 200 || typeof beforeData?.token !== 'string') {
      check('the message could be read first', false, `${before.status}`);
    } else {
      const generated = beforeData.generated ?? 'Ben jij beschikbaar?';
      const edited = `${generated}\n\n[smoke ${Date.now()}]`;
      const saved = await call(
        `${url}/whatsapp`,
        { method: 'PUT', body: JSON.stringify({ edited, base: generated, token: beforeData.token }) },
        jwt
      );
      check('saved', saved.status === 200, JSON.stringify(saved.body).slice(0, 200));
      const savedToken = (saved.body as { data?: { token?: string } }).data?.token;

      // The same write again with the ORIGINAL token: a lost response, not a conflict.
      const replay = await call(
        `${url}/whatsapp`,
        { method: 'PUT', body: JSON.stringify({ edited, base: generated, token: beforeData.token }) },
        jwt
      );
      check(
        'a retried identical save is not a conflict',
        replay.status === 200,
        `${replay.status} ${JSON.stringify(replay.body).slice(0, 160)}`
      );

      // A genuinely different write on a stale token must be refused.
      const conflict = await call(
        `${url}/whatsapp`,
        {
          method: 'PUT',
          body: JSON.stringify({ edited: `${edited} X`, base: generated, token: beforeData.token }),
        },
        jwt
      );
      check('a stale token is refused', conflict.status === CONFLICT, `${conflict.status}`);

      const removed = await call(
        `${url}/whatsapp`,
        { method: 'DELETE', body: JSON.stringify({ token: savedToken }) },
        jwt
      );
      check('cleaned up', removed.status === 200, JSON.stringify(removed.body).slice(0, 160));
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
