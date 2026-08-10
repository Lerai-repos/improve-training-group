import { NextResponse } from 'next/server';

import { resolveView } from '@lib/recommend';

import { guard } from './guard';

export const runtime = 'nodejs';

/**
 * GET /api/recommendations/[itemId] — the ranked list for one training.
 *
 * Requires the `view` capability. Note the scope this deliberately does NOT check:
 * membership of the Agenda board. A `view` holder may open any item id that ever
 * produced an artifact, including one since moved or superseded by next year's board.
 * Reading is account-wide and historical on purpose; the mutating routes are not.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  try {
    const { itemId } = await params;

    const allowed = await guard(request, 'view');
    if (!allowed.ok) {
      return allowed.response;
    }

    const view = await resolveView(allowed.deps.view, itemId, allowed.caller.caps);
    return NextResponse.json({ success: true, data: view });
  } catch (error) {
    // The detail goes to the log, never to the caller. Redis and Monday exception text
    // carries hostnames, key names and query fragments, and this endpoint is reachable
    // by anyone in the account — an error message is not the place to publish the shape
    // of the infrastructure.
    console.error('GET /api/recommendations/[itemId] failed', error instanceof Error ? error.stack : String(error));
    return NextResponse.json({ success: false, error: 'internal error' }, { status: 500 });
  }
}
