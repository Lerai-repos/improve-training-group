import { NextResponse } from 'next/server';

import {
  buildFailureCallbackDeps,
  handleFailureCallback,
  parseFailureCallback,
  parseJsonOrNull,
  verifyQStashRequest,
} from '@lib/recommend';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** Tells QStash to stop retrying and dead-letter the message immediately. */
const NON_RETRYABLE_STATUS = 489;

/**
 * POST /api/jobs/recommend/failed — QStash's failure callback.
 *
 * Fired once delivery attempts are exhausted, or immediately for a terminal 489.
 * Without it, a training whose newest generation failed would keep displaying the
 * PREVIOUS generation's label: stale, plausible and wrong.
 *
 * It does NOT simply write FOUT — see `failure-callback.ts`. A job that computed
 * GEREED and failed only at the Monday write must have that GEREED delivered.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const raw = await request.text();
  if (!(await verifyQStashRequest(request, raw))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const parsed = parseFailureCallback(parseJsonOrNull(raw));
  if (!parsed) {
    // 489, not 400: QStash retries EVERY non-2xx, so a 400 would redeliver a callback
    // that can never parse. This is a shape mismatch between our publish and our
    // receive — a deploy bug — so fail it fast into the DLQ where it can be seen.
    return NextResponse.json(
      { error: 'invalid failure callback' },
      { status: NON_RETRYABLE_STATUS, headers: { 'Upstash-NonRetryable-Error': 'true' } }
    );
  }

  const result = await handleFailureCallback(buildFailureCallbackDeps(), {
    mondayItemId: parsed.job.mondayItemId,
    generation: parsed.job.generation,
    dlqId: parsed.dlqId,
  });

  if (result.kind === 'undeliverable') {
    // Non-2xx so QStash redelivers this callback. 2xx here would mean "handled" while
    // the board still shows the PREVIOUS generation's label, ending convergence at the
    // exact moment Monday is unavailable — the case the callback exists for. Repeated
    // callbacks are safe: the outcome is immutable and `dlqId` gates the alert, so a
    // redelivery re-writes the same label and does not alert twice.
    return NextResponse.json({ ok: false, ...result }, { status: 500 });
  }

  return NextResponse.json({ ok: true, ...result });
}
