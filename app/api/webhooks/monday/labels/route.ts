import { NextResponse } from 'next/server';

import { labelsBoardId } from '@lib/labels';
import { buildKeuzelijstDeps, heeftFouten, syncKeuzelijsten } from '@lib/labels/keuzelijst-sync';
import { parseLabelsWebhook } from '@lib/labels/keuzelijst-webhook';
import { log } from '@lib/logger';
import { verifyWebhookToken } from '@lib/recommend';

export const runtime = 'nodejs';
export const maxDuration = 60;

// POST /api/webhooks/monday/labels?token=… — het Labels-bord.
//
// Een label erbij of hernoemd: het meteen in de keuzelijsten van de Opportunity en de agenda zetten.
// Zelfde gedeelde geheim als de andere Monday-webhooks, en vóór de challenge gecontroleerd: het
// geheim zit in de URL. Een 500 laat Monday het opnieuw proberen.
export async function POST(request: Request): Promise<NextResponse> {
  if (!verifyWebhookToken(request.url, process.env.MONDAY_WEBHOOK_TOKEN)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const parsed = parseLabelsWebhook(body, labelsBoardId());
  if (parsed.kind === 'challenge') {
    return NextResponse.json({ challenge: parsed.challenge });
  }
  if (parsed.kind === 'negeren') {
    return NextResponse.json({ ok: true, genegeerd: parsed.reden });
  }

  try {
    const rapport = await syncKeuzelijsten(buildKeuzelijstDeps({ dryRun: false }));
    if (heeftFouten(rapport)) {
      log.error('labels webhook: keuzelijst niet bijgewerkt', { doelen: rapport.doelen });
      return NextResponse.json({ ok: false, doelen: rapport.doelen }, { status: 500 });
    }
    log.info('labels webhook', { doelen: rapport.doelen });
    return NextResponse.json({ ok: true, doelen: rapport.doelen });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('labels webhook failed', { error: message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
