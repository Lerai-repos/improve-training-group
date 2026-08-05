import { NextResponse } from 'next/server';

import { authorizeBearer, buildQueueDeps, sweepPending } from '@lib/recommend';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * GET /api/cron/publish-pending — recover triggers whose publication never landed.
 *
 * This is what makes a job durable BEYOND Monday's 30-minute retry horizon. Without
 * it, a QStash outage outlasting that horizon would strand the trigger — and worse, a
 * generation that was allocated but never queued blocks every older generation from
 * writing, so the training ends up with no answer at all.
 *
 * Deliberately NOT a QStash schedule: a QStash schedule cannot recover a QStash outage.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorizeBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { store, publisher } = buildQueueDeps();
  const result = await sweepPending({ store, publisher, nowMs: Date.now });

  return NextResponse.json({ ok: true, ...result });
}
