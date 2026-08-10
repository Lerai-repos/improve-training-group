import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * GET /api/ping — is the server up?
 *
 * Deliberately unauthenticated and dependency-free: it must answer before Redis,
 * Monday or any configuration is reachable, because its job is to tell a readiness
 * probe that the process is listening. Anything it touched could turn "the server is
 * up" into "the server is up AND healthy", which is a different question with a
 * different answer.
 *
 * `playwright.config.ts` waits on this. The scaffold pointed at `/ping`, which no route
 * ever served — so the probe 404'd until it timed out and the route tests never ran.
 */
export function GET(): NextResponse {
  return NextResponse.json({ success: true, data: { status: 'ok' } });
}
