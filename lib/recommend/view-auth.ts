import { log } from '@lib/logger';

import {
  capabilitiesFor,
  type CapabilityPolicy,
  type Capabilities,
} from './capabilities';
import { verifySessionToken, type MondaySession, type SessionTokenConfig } from './session-token';

/**
 * Turn an incoming request into "who is asking, and what may they do" — or into the
 * status code that refuses it.
 *
 * Kept out of the route files on purpose. `.claude/rules/api-routes.md` wants routes
 * thin, but the stronger reason is that this is the entire access-control surface of the
 * feature: three routes each re-implementing the token/capability dance is three places
 * for one of them to quietly omit a check. There is one implementation and it is unit
 * tested.
 *
 * Both failures are reported to the caller as bare `unauthorized` / `forbidden`. The
 * specific reason — wrong account, expired, not in the map — goes to the log, not the
 * response: a caller probing the endpoint should not be told which part of their forgery
 * needs work.
 */

export interface AuthorizedCaller {
  session: MondaySession;
  caps: Capabilities;
}

export type AuthOutcome =
  | { ok: true; caller: AuthorizedCaller }
  | { ok: false; status: 401 | 403; error: string };

export interface AuthDeps {
  /** `now` is omitted in production, so `jose` uses the wall clock; tests inject it. */
  session: SessionTokenConfig;
  policy: CapabilityPolicy;
}

/**
 * The `sessionToken` Monday mints for the iframe, sent as a bearer token.
 *
 * Not a query parameter: URLs end up in access logs and browser history, and this token
 * authenticates a person rather than a machine. (The Monday *webhook* secret does ride
 * on the URL — that is Monday's choice for a server-to-server call we do not control.)
 */
export function readBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match ? match[1].trim() : '';
  return token === '' ? null : token;
}

/**
 * Separate from reading the header so a request with NO token can be refused before any
 * configuration is loaded. Otherwise an unconfigured deployment answers 500 to callers
 * who were never going to get in — which reads as a crash, and hides the actual
 * misconfiguration behind noise from unauthenticated traffic.
 */
/**
 * What a route demands. Not a ladder — see `capabilities.ts`; `view` is checked on top
 * of whichever of these is asked for.
 */
export type RequiredCapability = 'view' | 'plan' | 'full';

export async function authorizeToken(
  token: string,
  deps: AuthDeps,
  required: RequiredCapability
): Promise<AuthOutcome> {
  const verified = await verifySessionToken(token, deps.session);
  if (!verified.ok) {
    log.warn('recommendations: session token refused', { reason: verified.reason });
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  const caps = capabilitiesFor(verified.session.userId, deps.policy);

  // `view` is checked for every route, including the mutating ones. Someone who may not
  // look at the list has no business recalculating it either, and checking only the
  // specific capability would let a `plan`-without-`view` entry act blind — which is
  // also why the capability parser rejects that combination outright.
  if (
    !caps.view ||
    (required === 'plan' && !caps.plan) ||
    // `full` is a peer of `plan`, not a step above it: someone in finance may hold
    // `view,full` and never `plan`. The trainer overview asks for it because the whole
    // screen is scores, which the restricted row shape drops.
    (required === 'full' && !caps.full)
  ) {
    log.warn('recommendations: capability denied', {
      userId: verified.session.userId,
      required,
      caps,
    });
    return { ok: false, status: 403, error: 'forbidden' };
  }

  return { ok: true, caller: { session: verified.session, caps } };
}
