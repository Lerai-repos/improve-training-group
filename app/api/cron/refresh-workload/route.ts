import { NextResponse } from 'next/server';

import { authorizeBearer, buildWorkloadRefreshDeps, runWithDeadline } from '@lib/recommend';
import { log } from '@lib/logger';

export const runtime = 'nodejs';
/**
 * 300s like `eval-stats`, not the 60 of `publish-pending`: this pages the whole Agenda
 * board, one hundred trainings at a time.
 */
export const maxDuration = 300;
/** Headroom to answer rather than be killed; the scan itself budgets 60s internally. */
const RUN_DEADLINE_MS = 240_000;

/**
 * GET /api/cron/refresh-workload — rescan the Agenda board and refill the workload cache.
 *
 * Every five minutes (`vercel.json`), against a cache that lives fifteen. That ratio is
 * the fix, not the scan: three consecutive runs have to fail before "opdrachten deze
 * maand" and "opdrachten dit jaar" can go blank, and until then a slightly older count
 * is served instead of nothing.
 *
 * Before this existed the scan ran on the planner's own request under a six-second
 * budget while taking 5.5–8.5 seconds, so it lost about one time in three and the
 * columns emptied — the "blijven heel vaak leeg" ITG reported.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorizeBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedMs = Date.now();
  let boardId = 'unknown';
  try {
    /**
     * Inside the `try`, not before it.
     *
     * This throws on missing Redis or Monday configuration, and a deploy that is not
     * finished being configured is exactly when someone reads this route's output. Built
     * outside, that throw would skip both the documented JSON shape and the failure log,
     * and Vercel would show an unexplained crash instead of the reason.
     */
    const deps = buildWorkloadRefreshDeps();
    boardId = deps.boardId;

    const outcome = await runWithDeadline(startedMs + RUN_DEADLINE_MS, () =>
      /**
       * `awaitContended`, because a held lock is not a finished refresh.
       *
       * The likeliest holder is a planner's own warm-up on the request path, and that
       * one budgets six seconds against a scan that needs eight. Accepting `locked` as
       * success would let a warm-up time out and leave both columns blank for the next
       * five minutes while this route reported 200. So it waits for the holder and takes
       * over with its own sixty-second budget if nothing came of it.
       */
      deps.assignments.refresh({ awaitContended: true })
    );
    const durationMs = Date.now() - startedMs;

    if (!outcome.refreshed) {
      /**
       * Two different non-refreshes, and only one of them is good news.
       *
       * `locked` means the other holder finished and its scan IS cached — confirmed, so
       * there is genuinely nothing left to do. `contended` means somebody held the lock
       * for the entire wait and we never saw a value: probably another cron run mid-scan,
       * which will finish, but nothing about the cache is confirmed. Logging them the
       * same way would hide the case worth watching behind the routine one.
       *
       * Both are 200. An overlapping run is not a failing cron, and a 500 here would cry
       * wolf on the one signal that should mean the columns are actually at risk.
       */
      if (outcome.reason === 'locked') {
        log.debug('workload refresh skipped, another refresh had just finished', { boardId });
      } else {
        log.warn('workload refresh gave way, another refresh still held the lock', { boardId });
      }
      return NextResponse.json({
        ok: true,
        refreshed: false,
        // Defaulting to the WEAKER claim: an outcome that forgot to say why confirmed
        // nothing, and reporting it as `locked` would assert a cached value nobody saw.
        reason: outcome.reason ?? 'contended',
        durationMs,
      });
    }

    log.info('workload refreshed', { boardId, durationMs });
    return NextResponse.json({ ok: true, refreshed: true, durationMs });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedMs;
    /**
     * A 500 so Vercel surfaces it, but the previously cached scan is untouched —
     * `refresh` never writes the unavailable sentinel. The columns keep showing the
     * older counts, which is the entire point of a fifteen-minute TTL over a
     * five-minute schedule.
     */
    log.error('workload refresh failed', { boardId, message, durationMs });
    return NextResponse.json({ ok: false, error: message, durationMs }, { status: 500 });
  }
}
