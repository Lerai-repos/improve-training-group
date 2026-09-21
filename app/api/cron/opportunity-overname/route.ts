import { NextResponse } from 'next/server';

import { log } from '@lib/logger';
import { buildOvernameDeps, runOvername } from '@lib/overname';
import { authorizeBearer, currentDeadlineMs, runWithDeadline } from '@lib/recommend';

export const runtime = 'nodejs';
/** Alle levende agendaborden volledig doorbladeren (twee keer, voor de coherentietoets). */
export const maxDuration = 300;
const RUN_DEADLINE_MS = 260_000;

/**
 * GET /api/cron/opportunity-overname — de antwoorden van de Opportunity overnemen op de
 * komende trainingen.
 *
 * Gepland op 03:45 UTC (`vercel.json`): ná de dagelijkse controle van 03:15, zodat de twee
 * elkaars Monday-budget niet in de weg zitten. Bewust NIET onderdeel van die controle: die
 * schrijft alleen naar het Systeem-bord ("een controle, geen reparatie"); dit schrijft juist
 * naar de agenda.
 *
 * `?dryRun=1` leest en berekent alles zonder te schrijven.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorizeBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  // Fail closed: alleen de letterlijke '1' telt als droogloop.
  const dryRun = url.searchParams.get('dryRun') === '1';

  const started = Date.now();
  try {
    const report = await runWithDeadline(started + RUN_DEADLINE_MS, () =>
      runOvername(buildOvernameDeps({ dryRun, deadlineMs: currentDeadlineMs }))
    );
    const durationMs = Date.now() - started;

    /**
     * Een mislukt bord of een geweigerde schrijfactie is een 500, net als bij de dagelijkse
     * controle: de run heeft gedaan wat hij kon, maar er is een gat waar anders niemand van
     * weet.
     */
    if (report.mislukt.length > 0) {
      log.error('opportunity-overname partial', { mislukt: report.mislukt, durationMs });
      return NextResponse.json({ ok: false, durationMs, ...report }, { status: 500 });
    }

    log.info('opportunity-overname done', {
      dryRun: report.dryRun,
      trainingen: report.trainingen,
      metAntwoord: report.metAntwoord,
      geschreven: report.geschreven.length,
      conflicten: report.conflicten.length,
      durationMs,
    });
    return NextResponse.json({ ok: true, durationMs, ...report });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('opportunity-overname failed', { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
