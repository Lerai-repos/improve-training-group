import { jwtVerify } from 'jose';
import { z } from 'zod';

/**
 * Who is asking, according to Monday.
 *
 * The item view runs in an iframe inside Monday and calls our backend with a
 * `sessionToken` that Monday minted and signed with our app's client secret. That token
 * is the ONLY thing establishing identity here: there is no session cookie, no bearer
 * key, nothing else to fall back on. Everything the authorization layer decides rests on
 * what this file returns, so it is deliberately strict and returns a reason rather than
 * a boolean.
 *
 * Four properties are checked, and each exists because skipping it is exploitable:
 *
 * 1. **The signature**, against `MONDAY_APP_CLIENT_SECRET`. Without it anyone can mint
 *    a token naming any user.
 * 2. **The algorithm, pinned to HS256.** Never trust the header's `alg` — accepting
 *    whatever it names is the classic JWT forgery (`alg: none`, or an RS256 token
 *    verified as HMAC using the public key as the secret). `jose` will not downgrade
 *    unless we let it, so we do not.
 * 3. **`exp`, and its presence.** A token with no expiry never goes stale, so a leaked
 *    one would work forever; `requiredClaims` makes its absence a failure rather than a
 *    permanent pass.
 * 4. **The account.** A private app installs into one account, but a token from any
 *    other Monday account would still carry a valid signature if the secret ever leaked
 *    sideways — and, more mundanely, it catches pointing the app at the wrong workspace.
 *
 * The claims are nested under `dat`, not at the top level. Reading `payload.account_id`
 * would be `undefined` for every genuine token, which fails open in the worst way if the
 * comparison is ever written as "not present, so skip".
 */

export interface MondaySession {
  accountId: string;
  userId: string;
}

/** Why a token was refused. Every reason is a 401 to the caller; the distinction is for
 *  logs and tests, so a misconfiguration is not indistinguishable from an attack. */
export type SessionFailure =
  | 'malformed'
  | 'invalid_signature'
  | 'wrong_algorithm'
  | 'expired'
  | 'missing_claims'
  | 'wrong_account';

export type SessionResult =
  | { ok: true; session: MondaySession }
  | { ok: false; reason: SessionFailure };

export interface SessionTokenConfig {
  clientSecret: string;
  expectedAccountId: string;
  /** Injected in tests; real callers let `jose` use the wall clock. */
  now?: Date;
}

/**
 * Monday sends these as JSON numbers. Strings are accepted too because a numeric id
 * that survives a round trip through some client library as a string is the same id —
 * but only digits, so nothing can be smuggled past the account comparison by wrapping
 * it in whitespace or a leading `+`.
 */
const idSchema = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/, 'must be a numeric id'),
]);

const datSchema = z.object({
  account_id: idSchema,
  user_id: idSchema,
});

/** `code` is `jose`'s stable discriminator; the message is not. */
function joseCode(error: unknown): string | null {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return null;
}

function failureFor(error: unknown): SessionFailure {
  switch (joseCode(error)) {
    case 'ERR_JWT_EXPIRED':
      return 'expired';
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return 'invalid_signature';
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return 'wrong_algorithm';
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      return 'missing_claims';
    default:
      return 'malformed';
  }
}

export async function verifySessionToken(
  token: string,
  config: SessionTokenConfig
): Promise<SessionResult> {
  if (token.trim() === '') {
    return { ok: false, reason: 'malformed' };
  }

  let payload: unknown;
  try {
    const verified = await jwtVerify(token, new TextEncoder().encode(config.clientSecret), {
      algorithms: ['HS256'],
      requiredClaims: ['exp'],
      currentDate: config.now,
    });
    payload = verified.payload;
  } catch (error) {
    return { ok: false, reason: failureFor(error) };
  }

  // Signature verified — but a validly signed token can still carry nonsense, and
  // `payload` is `unknown` until something checks it.
  const parsed = z.object({ dat: datSchema }).safeParse(payload);
  if (!parsed.success) {
    return { ok: false, reason: 'missing_claims' };
  }

  const accountId = String(parsed.data.dat.account_id);
  if (accountId !== config.expectedAccountId) {
    return { ok: false, reason: 'wrong_account' };
  }

  return { ok: true, session: { accountId, userId: String(parsed.data.dat.user_id) } };
}

/**
 * Configuration, or a refusal to start.
 *
 * Both variables are required with no default. A missing client secret cannot mean
 * "skip verification" and a missing account id cannot mean "any account" — either
 * default would turn a deployment mistake into an open endpoint, and the symptom
 * (everything works) is the one nobody investigates.
 */
/**
 * The feature is not set up in this environment.
 *
 * Distinct from a crash, and answered as 503 rather than 500: "we cannot verify anyone"
 * is a deployment state with an obvious fix, and burying it in generic 500s is how a
 * missing variable turns into an afternoon of reading logs.
 */
export class RecommendationsNotConfigured extends Error {}

export function sessionTokenConfigFromEnv(): Omit<SessionTokenConfig, 'now'> {
  const clientSecret = (process.env.MONDAY_APP_CLIENT_SECRET ?? '').trim();
  const expectedAccountId = (process.env.MONDAY_ACCOUNT_ID ?? '').trim();

  const missing = [
    clientSecret === '' ? 'MONDAY_APP_CLIENT_SECRET' : null,
    expectedAccountId === '' ? 'MONDAY_ACCOUNT_ID' : null,
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new RecommendationsNotConfigured(
      `Monday session verification is not configured: missing ${missing.join(', ')}`
    );
  }

  return { clientSecret, expectedAccountId };
}
