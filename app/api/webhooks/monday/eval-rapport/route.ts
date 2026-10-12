import { after, NextResponse } from 'next/server';

import { log } from '@lib/logger';
import { currentDeadlineMs, runWithDeadline, verifyWebhookToken } from '@lib/recommend';
import { createRedisClient, createUpstashKvStore } from '@lib/recommend/kv';
import { parseEvalKnopWebhook, runEvalKnop } from '@lib/report/knop';
import { buildEvalKnopDeps } from '@lib/report/knop-deps';
import { verwerkEvalKnopWebhook } from '@lib/report/knop-webhook';

export const runtime = 'nodejs';
/** De verwerking loopt ná het antwoord, binnen dezelfde functie; zie `after()`. */
export const maxDuration = 300;
/** Ruim onder `maxDuration`, zodat een vastgelopen stap nog als melding eindigt. */
const RUN_DEADLINE_MS = 260_000;

// POST /api/webhooks/monday/eval-rapport?token=… — de knop Eval Rapport op het agendabord.
//
// De knop zet `Eval Status` op RUN; de webhook op die wijziging komt hier binnen. Zelfde
// gedeelde geheim als de andere Monday-webhooks, en vóór de challenge gecontroleerd.
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

  const parse = parseEvalKnopWebhook(body);
  try {
    const antwoord = await verwerkEvalKnopWebhook(parse, {
      kv: () => createUpstashKvStore(createRedisClient()),
      start: (itemId, boardId) => {
        after(async () => {
          try {
            const uitkomst = await runWithDeadline(Date.now() + RUN_DEADLINE_MS, () =>
              runEvalKnop(buildEvalKnopDeps(currentDeadlineMs), itemId, boardId)
            );
            log.info('eval-rapport knop verwerkt', {
              itemId,
              status: uitkomst.status,
              resultaat: uitkomst.line?.result,
              mails: uitkomst.line?.mailed,
            });
          } catch (error) {
            log.error('eval-rapport knop mislukt', {
              itemId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        });
      },
    });
    return NextResponse.json(antwoord.body, { status: antwoord.status });
  } catch (error) {
    // KV onbereikbaar: 500, zodat Monday het event opnieuw aflevert.
    const message = error instanceof Error ? error.message : String(error);
    log.error('eval-rapport webhook: kon de knopdruk niet aannemen', { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
