import { NextResponse } from 'next/server';

import { handleRecalculate } from '@lib/recommend';

import { guard, readJsonBody } from '../guard';

export const runtime = 'nodejs';

/**
 * POST /api/recommendations/[itemId]/recalculate — queue a fresh computation.
 *
 * Requires `plan`: this spends provider calls and moves the whole training to a new
 * generation, which every other planner looking at the item will see. The body carries
 * a client-minted `actionId`, reused across retries so a flaky network cannot buy two
 * computations.
 */
export async function POST(
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

    const result = await handleRecalculate(allowed.deps.recalculate(), {
      mondayItemId: itemId,
      body: json.body,
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    // The detail goes to the log, never to the caller. Redis and Monday exception text
    // carries hostnames, key names and query fragments, and this endpoint is reachable
    // by anyone in the account — an error message is not the place to publish the shape
    // of the infrastructure.
    console.error('POST /api/recommendations/[itemId]/recalculate failed', error instanceof Error ? error.stack : String(error));
    return NextResponse.json({ success: false, error: 'internal error' }, { status: 500 });
  }
}
