import { NextResponse } from 'next/server';

import {
  authorizeBearer,
  buildWebhookSyncDeps,
  runWithDeadline,
  syncWebhooks,
} from '@lib/recommend';
import { log } from '@lib/logger';
import { buildKnopWebhookSyncDeps } from '@lib/report/knop-webhook-deps';
import { syncEvalKnopWebhooks } from '@lib/report/knop-webhook-sync';

export const runtime = 'nodejs';
export const maxDuration = 60;
const RUN_DEADLINE_MS = 45_000;

/**
 * GET /api/cron/sync-webhooks — abonneer elk agendabord met aanbevelingen op de triggers,
 * en elk agendabord met Eval Status op de knop Eval Rapport.
 *
 * Elk uur. Dupliceert ITG een nieuwe jaargang, dan werken slepen naar Inplannen en de knop
 * daar binnen een uur, zonder dat iemand een commando draait. Maakt alleen aan, verwijdert nooit; zie
 * `lib/recommend/webhook-sync.ts` voor waarom.
 *
 * `?dryRun=1` laat zien wat er zou gebeuren.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!authorizeBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const dryRun = new URL(request.url).searchParams.get('dryRun') === '1';

  try {
    const { report, knop } = await runWithDeadline(Date.now() + RUN_DEADLINE_MS, async () => ({
      report: await syncWebhooks(buildWebhookSyncDeps({ dryRun })),
      // De knop Eval Rapport: elk agendabord met Eval Status, ook een nieuwe jaargang.
      knop: await syncEvalKnopWebhooks(buildKnopWebhookSyncDeps({ dryRun })),
    }));
    if (report.created.length > 0 || knop.created.length > 0) {
      log.info('webhooks aangemaakt', { dryRun, created: report.created, knop: knop.created });
    }
    if (report.failed.length > 0 || knop.failed.length > 0) {
      log.error('webhooks synchroniseren deels mislukt', {
        failed: report.failed,
        knop: knop.failed,
      });
      return NextResponse.json({ ok: false, dryRun, ...report, knop }, { status: 500 });
    }
    return NextResponse.json({ ok: true, dryRun, ...report, knop });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('webhooks synchroniseren mislukt', { message });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
