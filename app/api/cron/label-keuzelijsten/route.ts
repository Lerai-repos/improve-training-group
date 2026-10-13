import { NextResponse } from 'next/server';

import { buildKeuzelijstDeps, heeftFouten, syncKeuzelijsten } from '@lib/labels/keuzelijst-sync';
import { log } from '@lib/logger';
import { authorizeBearer, currentDeadlineMs, runWithDeadline } from '@lib/recommend';

export const runtime = 'nodejs';
export const maxDuration = 120;
const RUN_DEADLINE_MS = 100_000;

/**
 * GET /api/cron/label-keuzelijsten — de vangnetronde voor de keuzelijsten.
 *
 * De webhook op het Labels-bord zet een nieuw label meteen in de keuzelijsten; dit zet recht wat
 * hij miste, en neemt een nieuw agendabord mee zodra ITG de jaargang kopieert. Schrijft alleen als
 * er een label ontbreekt, dus vrijwel altijd niets.
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
    const rapport = await runWithDeadline(started + RUN_DEADLINE_MS, () =>
      syncKeuzelijsten(buildKeuzelijstDeps({ dryRun, deadlineMs: currentDeadlineMs }))
    );
    const durationMs = Date.now() - started;
    if (heeftFouten(rapport)) {
      log.error('label-keuzelijsten partial', { doelen: rapport.doelen, durationMs });
      return NextResponse.json({ ok: false, durationMs, ...rapport }, { status: 500 });
    }
    log.info('label-keuzelijsten done', { dryRun, doelen: rapport.doelen, durationMs });
    return NextResponse.json({ ok: true, durationMs, ...rapport });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('label-keuzelijsten failed', { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
