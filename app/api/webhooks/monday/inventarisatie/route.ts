import { NextResponse } from 'next/server';

import {
  buildInventarisatieDeps,
  parseInventarisatieWebhook,
  syncLink,
  verwerkInventarisatieWebhook,
} from '@lib/inventarisatie';
import { log } from '@lib/logger';
import { verifyWebhookToken } from '@lib/recommend';

export const runtime = 'nodejs';

// POST /api/webhooks/monday/inventarisatie?token=… — het Opportunitybord.
//
// Een nieuwe Opportunity of een ander label: de link naar het inventarisatieformulier meteen
// (opnieuw) zetten. Zelfde gedeelde geheim als de andere Monday-webhooks, en vóór de challenge
// gecontroleerd: het geheim zit in de URL.
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

  const result = await verwerkInventarisatieWebhook(parseInventarisatieWebhook(body), (itemId) =>
    syncLink(buildInventarisatieDeps({ dryRun: false }), itemId)
  );
  if (result.status >= 500) {
    log.error('inventarisatie webhook: link niet gezet', result.body);
  } else if ('link' in result.body) {
    log.info('inventarisatie webhook', result.body);
  }
  return NextResponse.json(result.body, { status: result.status });
}
