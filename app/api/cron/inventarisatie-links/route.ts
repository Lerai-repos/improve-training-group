import { NextResponse } from 'next/server';

import { buildInventarisatieDeps, syncAlleLinks } from '@lib/inventarisatie';
import { log } from '@lib/logger';
import { authorizeBearer, currentDeadlineMs, runWithDeadline } from '@lib/recommend';

export const runtime = 'nodejs';
export const maxDuration = 300;
const RUN_DEADLINE_MS = 260_000;

/**
 * GET /api/cron/inventarisatie-links — de vangnetronde over het hele Opportunitybord.
 *
 * De webhook zet de link meteen; dit zet recht wat hij miste: een storing, of een gedupliceerde
 * Opportunity met de link (en dus de referentie) van het origineel. Schrijft alleen verschillen,
 * dus na de eerste vulling (`pnpm inventarisatie:links --apply`) is dit bijna altijd niets.
 *
 * `?dryRun=1` leest en rekent zonder te schrijven.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorizeBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1';

  const started = Date.now();
  try {
    const report = await runWithDeadline(started + RUN_DEADLINE_MS, () =>
      syncAlleLinks(buildInventarisatieDeps({ dryRun, deadlineMs: currentDeadlineMs }))
    );
    const durationMs = Date.now() - started;
    if (report.mislukt.length > 0) {
      log.error('inventarisatie-links partial', { mislukt: report.mislukt, durationMs });
      return NextResponse.json({ ok: false, durationMs, ...report }, { status: 500 });
    }
    log.info('inventarisatie-links done', {
      dryRun,
      opportunities: report.opportunities,
      geschreven: report.geschreven,
      gewist: report.gewist,
      durationMs,
    });
    return NextResponse.json({ ok: true, durationMs, ...report });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('inventarisatie-links failed', { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
