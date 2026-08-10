import { NextResponse } from 'next/server';

import { handleApproached } from '@lib/recommend';

import { guard, readJsonBody } from '../guard';

export const runtime = 'nodejs';

/**
 * PUT /api/recommendations/[itemId]/approached — mark a trainer as contacted.
 *
 * Requires `plan`. Shared state: everyone looking at this training sees the mark, which
 * is the point — it stops two planners approaching the same trainer. The body names the
 * generation the client was looking at, and a stale one is refused rather than applied
 * to whatever list is current.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  try {
    const { itemId } = await params;

    const allowed = await guard(request, 'plan');
    if (!allowed.ok) {
      return allowed.response;
    }

    const json = await readJsonBody(request);
    if (!json.ok) {
      return json.response;
    }

    const result = await handleApproached(allowed.deps.approached(), {
      mondayItemId: itemId,
      body: json.body,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    // The detail goes to the log, never to the caller. Redis and Monday exception text
    // carries hostnames, key names and query fragments, and this endpoint is reachable
    // by anyone in the account — an error message is not the place to publish the shape
    // of the infrastructure.
    console.error('PUT /api/recommendations/[itemId]/approached failed', error instanceof Error ? error.stack : String(error));
    return NextResponse.json({ success: false, error: 'internal error' }, { status: 500 });
  }
}
