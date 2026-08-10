import { NextResponse } from 'next/server';

import {
  authorizeToken,
  buildViewDeps,
  readBearerToken,
  RecommendationsNotConfigured,
} from '@lib/recommend';

import type { AuthorizedCaller } from '@lib/recommend';

/**
 * The prologue every recommendations route shares: is this a caller we know, and may
 * they do the thing they are asking for?
 *
 * One implementation rather than three, because this is the feature's entire access
 * control surface and three copies is three chances for one to omit a check. The routes
 * stay thin per `.claude/rules/api-routes.md`; the decisions themselves live in
 * `lib/recommend/view-auth.ts` and are unit tested there.
 */

type Guarded =
  | { ok: true; caller: AuthorizedCaller; deps: ReturnType<typeof buildViewDeps> }
  | { ok: false; response: NextResponse };

const refuse = (status: number, error: string): { ok: false; response: NextResponse } => ({
  ok: false,
  response: NextResponse.json({ success: false, error }, { status }),
});

export async function guard(request: Request, required: 'view' | 'plan'): Promise<Guarded> {
  // Before any configuration is read: a request with no token is refused the same way
  // whether or not this environment is set up, and an unconfigured deployment does not
  // hide its one real problem behind 500s from anonymous traffic.
  const token = readBearerToken(request);
  if (token === null) {
    return refuse(401, 'unauthorized');
  }

  let deps: ReturnType<typeof buildViewDeps>;
  try {
    deps = buildViewDeps();
  } catch (error) {
    if (error instanceof RecommendationsNotConfigured) {
      // 503, not 500: this is a deployment state with an obvious fix, and it should not
      // read as a crash.
      console.error('recommendations: not configured', error.message);
      return refuse(503, 'the recommendations feature is not configured');
    }
    throw error;
  }

  const auth = await authorizeToken(token, deps.auth, required);
  if (!auth.ok) {
    return refuse(auth.status, auth.error);
  }

  return { ok: true, caller: auth.caller, deps };
}

/** Read a JSON body, or the 400 that says it was not one. */
export async function readJsonBody(
  request: Request
): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return refuse(400, 'invalid json');
  }
}
