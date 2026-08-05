import { NextResponse } from 'next/server';

import {
  buildJobStateDeps,
  buildStatusWriter,
  buildWorkerDeps,
  jobPayloadSchema,
  parseJsonOrNull,
  runJob,
  runRecommendation,
  runWithDeadline,
  verifyQStashRequest,
} from '@lib/recommend';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Absolute deadline for the compute inside this route, ~30s under `maxDuration` so
 * the outcome can be recorded and a controlled response returned before Vercel kills
 * the process. Note the QStash request timeout is deliberately set ABOVE
 * `maxDuration` (see `qstash.ts`): Vercel must always terminate first, or QStash
 * would release the Flow Control slot while this code was still running.
 */
const COMPUTE_DEADLINE_MS = 270_000;

/** Tells QStash to stop retrying and dead-letter the message immediately. */
const NON_RETRYABLE_STATUS = 489;

// POST /api/jobs/recommend — one queued recommendation run.
export async function POST(request: Request): Promise<NextResponse> {
  // Raw body first: the signature covers the bytes as sent.
  const raw = await request.text();
  if (!(await verifyQStashRequest(request, raw))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Guarded: a bare `JSON.parse` would THROW past the 489 branch below and surface as a
  // plain 500, which QStash treats as retryable — so a permanently malformed body would
  // be redelivered until it exhausted its retries instead of failing fast.
  const parsed = jobPayloadSchema.safeParse(parseJsonOrNull(raw));
  if (!parsed.success) {
    // Our own payload, so a mismatch is a deploy-shape bug, not a transient fault —
    // retrying it would just burn the budget.
    return NextResponse.json(
      { error: 'invalid job payload' },
      { status: NON_RETRYABLE_STATUS, headers: { 'Upstash-NonRetryable-Error': 'true' } }
    );
  }

  const state = buildJobStateDeps();

  const outcome = await runWithDeadline(Date.now() + COMPUTE_DEADLINE_MS, () =>
    runJob(
      {
        store: state.store,
        outcomes: state.outcomes,
        publisher: state.publisher,
        // Cheap: no network at construction, and delivery needs it either way.
        writer: buildStatusWriter(),
        // LAZY on purpose. `buildWorkerDeps` performs a full paginated roster read, and
        // `runJob` calls this only after it has ruled out supersession and an existing
        // outcome — so a stale job or a delivery-only retry costs no Monday quota at
        // all. Building it eagerly also put that read OUTSIDE the deadline, where a
        // roster outage could block delivery of an answer we already had.
        runRecommendation: async (mondayItemId) =>
          runRecommendation(await buildWorkerDeps(), mondayItemId),
      },
      parsed.data
    )
  );

  switch (outcome.kind) {
    case 'superseded':
      return NextResponse.json({ superseded: true });
    case 'delivered':
      return NextResponse.json({ delivered: true, label: outcome.label });
    case 'terminal':
      // FOUT is written and recorded. Retrying cannot change a blank date or an
      // unusable location, so stop and dead-letter for review.
      return NextResponse.json(
        { terminal: true, stage: outcome.stage },
        { status: NON_RETRYABLE_STATUS, headers: { 'Upstash-NonRetryable-Error': 'true' } }
      );
    case 'retry':
      // Nothing terminal was recorded, so a later attempt can still produce the real
      // answer. Non-2xx is what asks QStash for that attempt.
      return NextResponse.json({ error: outcome.message, stage: outcome.stage }, { status: 500 });
  }
}
