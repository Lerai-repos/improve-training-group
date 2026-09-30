import { NextResponse } from 'next/server';

import {
  briefingtekstenBoardId,
  parseTekstWebhook,
  synchroniseerStatussen,
  verwerkTekstWebhook,
} from '@lib/briefingteksten';
import { buildTekstenClients } from '@lib/briefingteksten/deps';
import { log } from '@lib/logger';
import { verifyWebhookToken } from '@lib/recommend';

export const runtime = 'nodejs';

// POST /api/webhooks/monday/briefingteksten?token=… — het bord Briefingteksten.
//
// Na elke bewerking van Kop, Tekst of Sleutel wordt het hele bord opnieuw gekeurd en krijgt
// elk item de juiste Status en Melding. Zelfde gedeelde geheim als de aanbevelingswebhook,
// en net als daar vóór de challenge: het geheim zit in de URL, dus ook op de challenge.
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

  let boardId: string;
  try {
    boardId = briefingtekstenBoardId();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('briefingteksten webhook: geen bord geconfigureerd', { message });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const result = await verwerkTekstWebhook(parseTekstWebhook(body, boardId), () => {
    const { read, write } = buildTekstenClients();
    return synchroniseerStatussen(read, write, boardId);
  });
  if (result.status >= 500) {
    log.error('briefingteksten webhook: keuren mislukt', result.body);
  }
  return NextResponse.json(result.body, { status: result.status });
}
