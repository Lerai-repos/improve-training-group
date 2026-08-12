import { NextResponse } from 'next/server';

import { authorizeBearer, buildEvalStatsDeps, runWithDeadline } from '@lib/recommend';
import { runNightly } from '@lib/evaluations';
import { log } from '@lib/logger';

export const runtime = 'nodejs';
/**
 * 300s, not the 60 that `publish-pending` uses: that one sweeps Redis, this reads three
 * Google documents, two Agenda boards and the Thema's board before it decides anything.
 */
export const maxDuration = 300;
/** ~40s of headroom to serialize the report and return it rather than being killed. */
const RUN_DEADLINE_MS = 260_000;

/**
 * GET /api/cron/eval-stats — recompute the trainer×thema statistics.
 *
 * Scheduled at 02:45 UTC (`vercel.json`): after local midnight, so the Europe/Amsterdam
 * completion date has flipped for the whole run, and before legacy Flow 9's 06:30 so the
 * two can be compared on the same day while both exist.
 *
 * `?dryRun=1` computes and reports without writing. `?force=1` overrides a refusal an
 * operator has looked at and accepted — never the authorization.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorizeBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  // Fail closed: anything other than the literal '1' is false.
  const dryRun = url.searchParams.get('dryRun') === '1' || process.env.EVAL_STATS_DRY_RUN === '1';
  const force = url.searchParams.get('force') === '1';

  const startedMs = Date.now();
  try {
    const report = await runWithDeadline(startedMs + RUN_DEADLINE_MS, () =>
      runNightly(buildEvalStatsDeps(), { dryRun, force })
    );

    const durationMs = Date.now() - startedMs;
    if (report.refused !== null) {
      log.error('eval-stats refused', {
        refused: report.refused,
        detail: report.detail,
        sources: report.sources,
        rows: report.rows,
      });
      // A 500 so Vercel surfaces it. A nightly job that 200s on a refusal is one nobody
      // watches, and the previous statistics keep being served in the meantime.
      return NextResponse.json({ ok: false, durationMs, ...report }, { status: 500 });
    }

    log.info('eval-stats done', {
      written: report.written,
      dryRun: report.dryRun,
      rows: report.rows,
      bytes: report.bytes,
      durationMs,
    });
    // The documented losses, every run: reported, never solved silently.
    log.warn('eval-stats known losses', {
      attributed: report.attribution.attributedResponses,
      total: report.attribution.totalResponses,
      losses: report.attribution.losses.map((loss) => ({
        kind: loss.kind,
        code: loss.code,
        responses: loss.responseCount,
      })),
      trainingsWithoutCode: report.attribution.trainingsWithoutCode,
      aggregatesUnused: report.stats.aggregatesUnused.length,
    });

    return NextResponse.json({ ok: true, durationMs, ...report });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('eval-stats failed', { message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
